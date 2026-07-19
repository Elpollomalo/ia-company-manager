const { Worker } = require('bullmq');
const { connection } = require('./config');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

console.log("🤖 El Orquestador 'ia-company-manager' está en línea y conectado con la API de Claude...");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 3;
const MAX_TURNOS_AGENTE = 15;
const PROJECT_ROOT = __dirname;

// Herramientas que el agente puede invocar para operar sobre el vault de verdad,
// en vez de solo devolver un bloque de texto.
const TOOLS = [
    {
        name: 'list_files',
        description: "Lista los archivos y subcarpetas dentro de una ruta relativa a la raíz del proyecto (ej. 'vault/2-atoms').",
        input_schema: {
            type: 'object',
            properties: {
                ruta: { type: 'string', description: "Ruta relativa a la raíz del proyecto, ej. 'vault/2-atoms'" },
            },
            required: ['ruta'],
        },
    },
    {
        name: 'read_file',
        description: 'Lee el contenido completo de un archivo, dada una ruta relativa a la raíz del proyecto.',
        input_schema: {
            type: 'object',
            properties: {
                ruta: { type: 'string', description: "Ruta relativa a la raíz del proyecto, ej. 'vault/2-atoms/nota.md'" },
            },
            required: ['ruta'],
        },
    },
    {
        name: 'write_file',
        description: 'Crea o sobreescribe un archivo con el contenido dado. Solo funciona dentro de las carpetas autorizadas para este agente; cualquier otra ruta es rechazada.',
        input_schema: {
            type: 'object',
            properties: {
                ruta: { type: 'string', description: 'Ruta relativa a la raíz del proyecto donde escribir' },
                contenido: { type: 'string', description: 'Contenido completo a escribir en el archivo' },
            },
            required: ['ruta', 'contenido'],
        },
    },
];

// Herramienta opcional: solo se ofrece a agentes cuyo playbook declare `db_access: true`.
const SQL_TOOL = {
    name: 'run_sql',
    description: 'Ejecuta una sentencia SQL real contra la base de datos de staging configurada (SUPABASE_DB_URL). Sentencias destructivas (DROP, DELETE, ALTER, TRUNCATE) son rechazadas automáticamente por el sistema y requieren aprobación humana explícita fuera de este flujo.',
    input_schema: {
        type: 'object',
        properties: {
            sql: { type: 'string', description: 'La sentencia SQL exacta a ejecutar.' },
        },
        required: ['sql'],
    },
};

const SQL_DESTRUCTIVO = /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i;

async function ejecutarSQL(sql) {
    if (!process.env.SUPABASE_DB_URL) {
        return 'RECHAZADO: no hay SUPABASE_DB_URL configurada en el entorno.';
    }
    if (SQL_DESTRUCTIVO.test(sql)) {
        return 'RECHAZADO: esta sentencia contiene una operación destructiva (DROP/DELETE/TRUNCATE/ALTER). Requiere aprobación humana explícita fuera de este flujo automático — repórtala en tu respuesta final en vez de ejecutarla.';
    }
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    try {
        await client.connect();
        const resultado = await client.query(sql);
        const filas = resultado.rows && resultado.rows.length ? JSON.stringify(resultado.rows).slice(0, 1000) : '';
        return `OK. Filas afectadas/devueltas: ${resultado.rowCount ?? 0}. ${filas}`;
    } catch (err) {
        return `ERROR SQL: ${err.message}`;
    } finally {
        await client.end().catch(() => {});
    }
}

function resolverRutaSegura(rutaRelativa) {
    const rutaAbsoluta = path.resolve(PROJECT_ROOT, rutaRelativa);
    if (rutaAbsoluta !== PROJECT_ROOT && !rutaAbsoluta.startsWith(PROJECT_ROOT + path.sep)) {
        throw new Error(`Ruta fuera del proyecto no permitida: ${rutaRelativa}`);
    }
    return rutaAbsoluta;
}

function rutaEstaAutorizada(rutaRelativa, writePaths) {
    const normalizada = rutaRelativa.replace(/^\.\//, '').replace(/\/+$/, '');
    return writePaths.some((base) => normalizada === base || normalizada.startsWith(`${base}/`));
}

async function ejecutarTool(nombre, input, writePaths, dbAccess) {
    switch (nombre) {
        case 'list_files': {
            const rutaAbs = resolverRutaSegura(input.ruta);
            if (!fs.existsSync(rutaAbs)) return `La ruta '${input.ruta}' no existe.`;
            const entradas = fs.readdirSync(rutaAbs, { withFileTypes: true });
            const listado = entradas.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
            return listado || '(carpeta vacía)';
        }
        case 'read_file': {
            const rutaAbs = resolverRutaSegura(input.ruta);
            if (!fs.existsSync(rutaAbs)) return `El archivo '${input.ruta}' no existe.`;
            return fs.readFileSync(rutaAbs, 'utf-8');
        }
        case 'write_file': {
            if (!rutaEstaAutorizada(input.ruta, writePaths)) {
                return `RECHAZADO: este agente no tiene autoridad de escritura sobre '${input.ruta}'. Rutas permitidas: ${writePaths.join(', ')}`;
            }
            const rutaAbs = resolverRutaSegura(input.ruta);
            fs.mkdirSync(path.dirname(rutaAbs), { recursive: true });
            fs.writeFileSync(rutaAbs, input.contenido, 'utf-8');
            return `Archivo guardado en '${input.ruta}' (${input.contenido.length} caracteres).`;
        }
        case 'run_sql': {
            if (!dbAccess) {
                return 'RECHAZADO: este agente no tiene autoridad para ejecutar SQL (falta db_access: true en su playbook).';
            }
            return await ejecutarSQL(input.sql);
        }
        default:
            return `Herramienta desconocida: ${nombre}`;
    }
}

const worker = new Worker('cola-de-agentes', async (job) => {
    const { agente, proyecto, tarea } = job.data;
    console.log(`\n⚡ Procesando: Agente [${agente}] | Proyecto [${proyecto}]`);

    const playbookPath = path.join(__dirname, 'agents', `${agente}.md`);
    const houseRulesPath = path.join(__dirname, 'house-rules.md');
    const sourcesDir = path.join(__dirname, 'vault', 'sources', proyecto.toLowerCase());

    if (!fs.existsSync(playbookPath)) {
        throw new Error(`El playbook para el agente '${agente}' no existe.`);
    }

    const houseRules = fs.readFileSync(houseRulesPath, 'utf-8');
    const playbookContenido = fs.readFileSync(playbookPath, 'utf-8');

    let temperaturaAgente = 0;
    const matchTemp = playbookContenido.match(/temperature:\s*([\d.]+)/);
    if (matchTemp) {
        temperaturaAgente = parseFloat(matchTemp[1]);
    }

    let writePaths = [];
    const matchWritePaths = playbookContenido.match(/write_paths:\s*(.+)/);
    if (matchWritePaths) {
        writePaths = matchWritePaths[1].split(',').map((p) => p.trim().replace(/\/+$/, ''));
    }

    const dbAccess = /db_access:\s*true/i.test(playbookContenido);
    const herramientas = dbAccess ? [...TOOLS, SQL_TOOL] : TOOLS;

    let proyectoContexto = "No hay archivos de contexto específicos en vault/sources/ todavía.";
    if (fs.existsSync(sourcesDir)) {
        const archivosContexto = fs.readdirSync(sourcesDir).filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
        if (archivosContexto.length > 0) {
            proyectoContexto = archivosContexto
                .map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(sourcesDir, f), 'utf-8')}`)
                .join('\n\n');
        }
    }

    // claude-sonnet-5 ya no acepta el parámetro `temperature` (la API lo rechaza con 400).
    // El frontmatter sigue clasificando al agente como preciso (0) o con voz propia (>0);
    // en vez de un parámetro numérico, esa intención se traduce en una instrucción de prompt.
    const modoCreativo = temperaturaAgente > 0;
    const instruccionVoz = modoCreativo
        ? '\n\nEste rol requiere voz propia: varía tu redacción y estructura, evita sonar robótico o repetitivo. No sacrifiques la fidelidad a las fuentes por creatividad.'
        : '';

    console.log(`🧠 Invocando a Claude usando el rol de ${agente} (modo ${modoCreativo ? 'creativo' : 'preciso'}, escritura: ${writePaths.join(', ') || 'ninguna'}, db_access: ${dbAccess}) para el proyecto ${proyecto}...`);

    const instruccionSQL = dbAccess
        ? '\n\nTambién tienes acceso a run_sql para ejecutar SQL real contra la base de datos de staging. Sentencias destructivas (DROP/DELETE/ALTER/TRUNCATE) son rechazadas automáticamente por el sistema; si necesitas una, repórtala en tu respuesta final para que un humano la revise, no intentes forzarla.'
        : '';

    const systemPrompt = `Eres un agente de IA especializado que forma parte de una organización virtual.
        Debes actuar estrictamente bajo los siguientes estatutos y playbooks.
        Tienes acceso a herramientas (list_files, read_file, write_file) para operar sobre el filesystem real del vault. Úsalas para cumplir tu misión: no te limites a describir lo que harías, hazlo.
        write_file solo funciona dentro de tus rutas autorizadas: ${writePaths.join(', ') || 'ninguna'}. Cualquier intento fuera de esas rutas será rechazado automáticamente.${instruccionVoz}${instruccionSQL}

        === ESTATUTOS DEL SISTEMA (HOUSE RULES) ===
        ${houseRules}

        === TU PLAYBOOK DE ROL ===
        ${playbookContenido}

        === CONTEXTO DEL PROYECTO ACTUAL ===
        ${proyectoContexto}`;

    let messages = [
        { role: 'user', content: `Ejecuta la siguiente tarea de forma estricta: ${tarea}` },
    ];

    const bitacoraHerramientas = [];
    let ultimaRespuesta = null;
    let turnos = 0;

    while (turnos < MAX_TURNOS_AGENTE) {
        turnos++;

        ultimaRespuesta = await anthropic.messages.create({
            model: 'claude-sonnet-5',
            max_tokens: 4000,
            system: systemPrompt,
            tools: herramientas,
            messages,
        });

        if (ultimaRespuesta.stop_reason !== 'tool_use') {
            break;
        }

        messages.push({ role: 'assistant', content: ultimaRespuesta.content });

        const resultadosHerramientas = [];
        for (const bloque of ultimaRespuesta.content) {
            if (bloque.type !== 'tool_use') continue;

            console.log(`🔧 [${agente}] invoca '${bloque.name}':`, JSON.stringify(bloque.input));

            let resultado;
            try {
                resultado = await ejecutarTool(bloque.name, bloque.input, writePaths, dbAccess);
            } catch (err) {
                resultado = `ERROR: ${err.message}`;
            }

            bitacoraHerramientas.push({ herramienta: bloque.name, input: bloque.input, resultado });
            resultadosHerramientas.push({
                type: 'tool_result',
                tool_use_id: bloque.id,
                content: String(resultado),
            });
        }

        messages.push({ role: 'user', content: resultadosHerramientas });
    }

    if (turnos >= MAX_TURNOS_AGENTE) {
        console.warn(`⚠️ [${agente}] alcanzó el límite de ${MAX_TURNOS_AGENTE} turnos sin terminar. Se guarda el estado parcial.`);
    }

    const bloquesTexto = (ultimaRespuesta.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    const resultadoIA = bloquesTexto.join('\n\n') || '(el agente no devolvió texto final en este turno)';

    const bitacoraTexto = bitacoraHerramientas.length
        ? bitacoraHerramientas.map((b) => `- ${b.herramienta}(${JSON.stringify(b.input)}) → ${b.resultado.slice(0, 200)}`).join('\n')
        : '(el agente no invocó ninguna herramienta)';

    // Guardamos un resumen legible de la corrida en el escritorio temporal;
    // las acciones reales sobre el vault ya ocurrieron vía las herramientas.
    const nombreArchivoSalida = `${agente}_${proyecto.toLowerCase()}_${job.id}.md`;
    const rutaSalida = path.join(__dirname, 'vault', '1-desk', nombreArchivoSalida);

    const contenidoSalida = `# Corrida de ${agente} — ${proyecto}\n\n## Respuesta final\n${resultadoIA}\n\n## Herramientas invocadas\n${bitacoraTexto}\n`;

    fs.mkdirSync(path.dirname(rutaSalida), { recursive: true });
    fs.writeFileSync(rutaSalida, contenidoSalida, 'utf-8');
    console.log(`💾 Resumen de la corrida guardado en: vault/1-desk/${nombreArchivoSalida}`);

    return { status: 'success', archivoGenerado: nombreArchivoSalida, herramientasInvocadas: bitacoraHerramientas.length };
}, { connection, concurrency: WORKER_CONCURRENCY });

worker.on('completed', (job) => console.log(`✅ Tarea ${job.id} procesada con éxito por la IA.`));
worker.on('failed', (job, err) => console.error(`❌ Tarea ${job.id} falló de forma crítica:`, err.message));
