const { Worker } = require('bullmq');
const { connection } = require('./config');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
require('dotenv').config();

const execFileAsync = promisify(execFile);
const VAULT_DIR = path.join(__dirname, 'vault');

// Cumple la regla de house-rules.md: "commitear vault/ después de cada corrida
// del worker, para poder revertir si un agente comete un error". vault/ es su
// propio repo git (privado), separado del repo principal.
async function commitVault(mensaje) {
    try {
        await execFileAsync('git', ['add', '-A'], { cwd: VAULT_DIR });
        await execFileAsync('git', ['commit', '-m', mensaje], { cwd: VAULT_DIR });
        console.log(`📦 vault/ commiteado: ${mensaje}`);
    } catch (err) {
        const salida = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
        if (!/nothing to commit/i.test(salida)) {
            console.warn(`⚠️ No se pudo commitear vault/: ${err.message}`);
        }
    }
}

console.log("🤖 El Orquestador 'ia-company-manager' está en línea y conectado con la API de Claude...");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 3;
const MAX_TURNOS_AGENTE = 15;
const PROJECT_ROOT = __dirname;

// DeepSeek habla el formato de function-calling de OpenAI, no el de Anthropic —
// mismo input_schema de fondo, distinto envoltorio.
function herramientasFormatoOpenAI(herramientasAnthropic) {
    return herramientasAnthropic.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

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

    const matchProvider = playbookContenido.match(/provider:\s*(\w+)/);
    const provider = matchProvider ? matchProvider[1].trim().toLowerCase() : 'anthropic';
    if (provider === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
        throw new Error(`El agente '${agente}' está configurado con provider: deepseek pero falta DEEPSEEK_API_KEY en .env`);
    }

    // No volcamos el contenido de vault/sources/ aquí: el agente ya tiene list_files/read_file
    // para pedir exactamente lo que necesita. Servir la carpeta completa de antemano
    // (a veces varios archivos grandes) desperdicia contexto en cada turno sin necesidad.
    const proyectoContexto = fs.existsSync(sourcesDir)
        ? `Las fuentes de este proyecto viven en 'vault/sources/${proyecto.toLowerCase()}/'. La tarea ya te indica qué archivo es la fuente relevante — léelo con read_file. Usa list_files si necesitas ver qué más hay en esa carpeta antes de decidir.`
        : `No hay carpeta 'vault/sources/${proyecto.toLowerCase()}/' todavía.`;

    // claude-sonnet-5 ya no acepta el parámetro `temperature` (la API lo rechaza con 400).
    // El frontmatter sigue clasificando al agente como preciso (0) o con voz propia (>0);
    // en vez de un parámetro numérico, esa intención se traduce en una instrucción de prompt.
    const modoCreativo = temperaturaAgente > 0;
    const instruccionVoz = modoCreativo
        ? '\n\nEste rol requiere voz propia: varía tu redacción y estructura, evita sonar robótico o repetitivo. No sacrifiques la fidelidad a las fuentes por creatividad.'
        : '';

    console.log(`🧠 Invocando a ${provider} usando el rol de ${agente} (modo ${modoCreativo ? 'creativo' : 'preciso'}, escritura: ${writePaths.join(', ') || 'ninguna'}, db_access: ${dbAccess}) para el proyecto ${proyecto}...`);

    const instruccionSQL = dbAccess
        ? '\n\nTambién tienes acceso a run_sql para ejecutar SQL real contra la base de datos de staging. Sentencias destructivas (DROP/DELETE/ALTER/TRUNCATE) son rechazadas automáticamente por el sistema; si necesitas una, repórtala en tu respuesta final para que un humano la revise, no intentes forzarla.'
        : '';

    // Bloque estático (idéntico para todas las tareas de este agente): se marca con
    // cache_control para que la API lo cachee entre turnos de una misma corrida y entre
    // corridas distintas del mismo rol, en vez de volver a cobrarlo entero cada vez.
    const systemEstatico = `Eres un agente de IA especializado que forma parte de una organización virtual.
        Debes actuar estrictamente bajo los siguientes estatutos y playbooks.
        Tienes acceso a herramientas (list_files, read_file, write_file) para operar sobre el filesystem real del vault. Úsalas para cumplir tu misión: no te limites a describir lo que harías, hazlo.
        write_file solo funciona dentro de tus rutas autorizadas: ${writePaths.join(', ') || 'ninguna'}. Cualquier intento fuera de esas rutas será rechazado automáticamente.${instruccionVoz}${instruccionSQL}

        === ESTATUTOS DEL SISTEMA (HOUSE RULES) ===
        ${houseRules}

        === TU PLAYBOOK DE ROL ===
        ${playbookContenido}`;

    const systemPrompt = [
        { type: 'text', text: systemEstatico, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `=== CONTEXTO DEL PROYECTO ACTUAL ===\n${proyectoContexto}` },
    ];

    const bitacoraHerramientas = [];
    let turnos = 0;
    let resultadoIA = '(el agente no devolvió texto final en este turno)';
    let agotoTokens = false;

    if (provider === 'deepseek') {
        // DeepSeek habla formato OpenAI: system va como mensaje normal (no hay parámetro
        // `system` aparte), y el caching de contexto es automático por prefijo estable —
        // no requiere ningún cache_control explícito.
        const systemTextoPlano = `${systemEstatico}\n\n=== CONTEXTO DEL PROYECTO ACTUAL ===\n${proyectoContexto}`;
        const herramientasDS = herramientasFormatoOpenAI(herramientas);

        let messagesDS = [
            { role: 'system', content: systemTextoPlano },
            { role: 'user', content: `Ejecuta la siguiente tarea de forma estricta: ${tarea}` },
        ];

        while (turnos < MAX_TURNOS_AGENTE) {
            turnos++;

            const respuesta = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    max_tokens: 8000,
                    messages: messagesDS,
                    tools: herramientasDS,
                }),
            });

            if (!respuesta.ok) {
                const errorTexto = await respuesta.text();
                throw new Error(`DeepSeek ${respuesta.status}: ${errorTexto}`);
            }

            const data = await respuesta.json();
            const choice = data.choices[0];
            const finishReason = choice.finish_reason;

            console.log(`↳ [${agente}] turno ${turnos} — finish_reason: ${finishReason}`);

            if (finishReason === 'length') {
                agotoTokens = true;
                console.warn(`⚠️ [${agente}] se quedó sin tokens de salida a media respuesta (turno ${turnos}).`);
            }

            if (finishReason !== 'tool_calls') {
                resultadoIA = choice.message.content || resultadoIA;
                break;
            }

            messagesDS.push(choice.message);

            for (const toolCall of choice.message.tool_calls) {
                const input = JSON.parse(toolCall.function.arguments);
                console.log(`🔧 [${agente}] invoca '${toolCall.function.name}':`, JSON.stringify(input));

                let resultado;
                try {
                    resultado = await ejecutarTool(toolCall.function.name, input, writePaths, dbAccess);
                } catch (err) {
                    resultado = `ERROR: ${err.message}`;
                }

                bitacoraHerramientas.push({ herramienta: toolCall.function.name, input, resultado });
                messagesDS.push({ role: 'tool', tool_call_id: toolCall.id, content: String(resultado) });
            }
        }
    } else {
        let messages = [
            { role: 'user', content: `Ejecuta la siguiente tarea de forma estricta: ${tarea}` },
        ];
        let ultimaRespuesta = null;

        while (turnos < MAX_TURNOS_AGENTE) {
            turnos++;

            ultimaRespuesta = await anthropic.messages.create({
                model: 'claude-sonnet-5',
                max_tokens: 16000,
                system: systemPrompt,
                tools: herramientas,
                messages,
            });

            console.log(`↳ [${agente}] turno ${turnos} — stop_reason: ${ultimaRespuesta.stop_reason}`);

            if (ultimaRespuesta.stop_reason === 'max_tokens') {
                agotoTokens = true;
                console.warn(`⚠️ [${agente}] se quedó sin tokens de salida a media respuesta (turno ${turnos}). Es probable que haya perdido una escritura o entregable en curso.`);
            }

            if (ultimaRespuesta.stop_reason !== 'tool_use') {
                const bloquesTexto = (ultimaRespuesta.content || []).filter((b) => b.type === 'text').map((b) => b.text);
                resultadoIA = bloquesTexto.join('\n\n') || resultadoIA;
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
    }

    if (turnos >= MAX_TURNOS_AGENTE) {
        console.warn(`⚠️ [${agente}] alcanzó el límite de ${MAX_TURNOS_AGENTE} turnos sin terminar. Se guarda el estado parcial.`);
    }

    const bitacoraTexto = bitacoraHerramientas.length
        ? bitacoraHerramientas.map((b) => `- ${b.herramienta}(${JSON.stringify(b.input)}) → ${b.resultado.slice(0, 200)}`).join('\n')
        : '(el agente no invocó ninguna herramienta)';

    // Guardamos un resumen legible de la corrida en el escritorio temporal;
    // las acciones reales sobre el vault ya ocurrieron vía las herramientas.
    // Incluye job.timestamp además de job.id: si Redis pierde el contador de IDs
    // (reinicio sin snapshot reciente, AOF apagado) el ID puede repetirse y
    // sobreescribir en silencio un resumen viejo — el timestamp lo evita.
    const nombreArchivoSalida = `${agente}_${proyecto.toLowerCase()}_${job.id}-${job.timestamp}.md`;
    const rutaSalida = path.join(__dirname, 'vault', '1-desk', nombreArchivoSalida);

    const avisoIncompleta = agotoTokens
        ? `\n\n⚠️ **Corrida posiblemente incompleta**: se quedó sin tokens de salida a media respuesta. Puede que haya perdido un write_file en curso.\n`
        : '';

    const contenidoSalida = `# Corrida de ${agente} — ${proyecto}\n\n## Respuesta final${avisoIncompleta}\n${resultadoIA}\n\n## Herramientas invocadas\n${bitacoraTexto}\n`;

    fs.mkdirSync(path.dirname(rutaSalida), { recursive: true });
    fs.writeFileSync(rutaSalida, contenidoSalida, 'utf-8');
    console.log(`💾 Resumen de la corrida guardado en: vault/1-desk/${nombreArchivoSalida}`);

    await commitVault(`${agente} (${provider}) — ${proyecto} — tarea ${job.id}`);

    return { status: 'success', archivoGenerado: nombreArchivoSalida, herramientasInvocadas: bitacoraHerramientas.length };
}, { connection, concurrency: WORKER_CONCURRENCY });

worker.on('completed', (job) => console.log(`✅ Tarea ${job.id} procesada con éxito por la IA.`));
worker.on('failed', (job, err) => console.error(`❌ Tarea ${job.id} falló de forma crítica:`, err.message));
