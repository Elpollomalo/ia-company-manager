const { Worker } = require('bullmq');
const { connection } = require('./config');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { notificar } = require('./scripts/telegram-notify');
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
        return;
    }
    // El commit local no sirve como respaldo real si nunca llega a GitHub —
    // sin este push, un disco corrupto se lleva toda la historia con él.
    try {
        await execFileAsync('git', ['push', 'origin', 'main'], { cwd: VAULT_DIR });
        console.log('☁️  vault/ pusheado a GitHub');
    } catch (err) {
        console.warn(`⚠️ No se pudo pushear vault/ a GitHub: ${err.stderr || err.message}`);
    }
}

console.log("🤖 El Orquestador 'ia-company-manager' está en línea y conectado con la API de Claude...");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 3;
const MAX_TURNOS_AGENTE = 30;
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

// Herramienta opcional: gateada por el mismo flag `db_access: true` que run_sql,
// ya que hoy solo el Programador la usa (proyecto TourBrain, base en Airtable).
const AIRTABLE_TOOL = {
    name: 'run_airtable',
    description: "Ejecuta una llamada real contra la API REST de Airtable (v0) sobre la base configurada en AIRTABLE_BASE_ID, usando el Personal Access Token del entorno. Sirve tanto para gestionar el schema (crear/listar tablas y campos vía 'meta/bases/{baseId}/...') como para leer/escribir registros (vía '{baseId}/NombreTabla'). Usa el literal '{baseId}' en la ruta; el sistema lo sustituye automáticamente. El método DELETE es rechazado automáticamente y requiere aprobación humana explícita fuera de este flujo.",
    input_schema: {
        type: 'object',
        properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT'], description: 'Método HTTP de la llamada.' },
            ruta: { type: 'string', description: "Ruta relativa bajo https://api.airtable.com/v0/, ej. 'meta/bases/{baseId}/tables' o '{baseId}/Proveedores'. Usa el placeholder '{baseId}'." },
            body: { type: 'object', description: 'Cuerpo JSON de la petición. Omitir en GET.' },
        },
        required: ['method', 'ruta'],
    },
};

// Herramienta opcional: gateada por `web_access: true` en el playbook. Permite a un agente
// leer el contenido real de una URL pública (ej. el sitio en producción de un proyecto),
// no solo lo que ya está documentado en el vault. Solo lectura — no hay forma de escribir
// ni de disparar acciones vía esta herramienta, así que no requiere el mismo tipo de rechazo
// de operaciones destructivas que run_sql/run_airtable.
const WEB_FETCH_TOOL = {
    name: 'fetch_url',
    description: 'Descarga una URL pública real (GET) y devuelve su texto legible (HTML convertido a texto plano, sin scripts/estilos). Úsala para leer el contenido actual de una página web real, no inventes lo que dice una página sin haberla leído con esta herramienta.',
    input_schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'URL completa a descargar, ej. https://ejemplo.com/pagina' },
        },
        required: ['url'],
    },
};

const TEXTO_MAX_CHARS = 12000;

function htmlATexto(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

async function ejecutarFetchUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return `RECHAZADO: '${url}' no es una URL válida.`;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        return `RECHAZADO: solo se permiten URLs http/https, no '${parsed.protocol}'.`;
    }
    try {
        const respuesta = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ia-company-manager-bot/1.0)' },
            signal: AbortSignal.timeout(15000),
        });
        if (!respuesta.ok) {
            return `ERROR (${respuesta.status} ${respuesta.statusText}) al descargar ${url}.`;
        }
        const contentType = respuesta.headers.get('content-type') || '';
        const cuerpo = await respuesta.text();
        const texto = contentType.includes('html') ? htmlATexto(cuerpo) : cuerpo.trim();
        const truncado = texto.length > TEXTO_MAX_CHARS;
        return `URL: ${url}\nEstado: ${respuesta.status}\n\n${texto.slice(0, TEXTO_MAX_CHARS)}${truncado ? `\n\n[TRUNCADO — el texto real sigue, esto son los primeros ${TEXTO_MAX_CHARS} caracteres]` : ''}`;
    } catch (err) {
        return `ERROR al descargar ${url}: ${err.message}`;
    }
}

// Herramienta opcional: gateada por el MISMO `web_access: true` que fetch_url (no es una
// capacidad nueva de internet, es otra forma de leer una página ya autorizada). A diferencia
// de fetch_url (que convierte el HTML a texto plano, perdiendo colores/imágenes), esta lee el
// HTML crudo para sacar el favicon/logo real y los colores hexadecimales que el sitio usa —
// pensada para conocer la identidad visual real de un prospecto antes de escribirle una
// propuesta o generarle una maqueta.
const BRAND_EXTRACT_TOOL = {
    name: 'extract_site_branding',
    description: 'Analiza el HTML real de una URL para encontrar su logo/favicon y los colores hexadecimales que usa. Si le das guardar_logo_en (una ruta dentro de tus carpetas autorizadas), además descarga el logo/favicon encontrado como archivo. Úsala sobre el sitio de un prospecto antes de escribir su propuesta o generar su maqueta, para que use su identidad visual real en vez de inventar una.',
    input_schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'URL del sitio a analizar, ej. https://www.cozudive.com/' },
            guardar_logo_en: { type: 'string', description: "Ruta relativa donde guardar el logo/favicon si se encuentra, ej. 'vault/sources/creativa-balam/prospectos/cozudive/marca/logo-original.png'. Omitir si solo quieres el reporte de colores/URL sin descargar el archivo." },
        },
        required: ['url'],
    },
};

function extraerColoresHex(html) {
    const encontrados = html.match(/#[0-9a-fA-F]{6}\b/g) || [];
    const conteo = {};
    for (const c of encontrados) {
        const norm = c.toLowerCase();
        conteo[norm] = (conteo[norm] || 0) + 1;
    }
    return Object.entries(conteo)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([color, veces]) => `${color} (${veces}×)`);
}

function extraerUrlLogo(html, baseUrl) {
    const patrones = [
        /<link[^>]+rel=["'](?:apple-touch-icon)[^"']*["'][^>]*href=["']([^"']+)["']/i,
        /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i,
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    ];
    for (const patron of patrones) {
        const m = html.match(patron);
        if (m) {
            try {
                return new URL(m[1], baseUrl).toString();
            } catch {
                continue;
            }
        }
    }
    return null;
}

async function ejecutarExtractBranding(url, guardarLogoEn, writePaths) {
    let respuesta;
    try {
        respuesta = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ia-company-manager-bot/1.0)' },
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        return `ERROR al descargar ${url}: ${err.message}`;
    }
    if (!respuesta.ok) {
        return `ERROR (${respuesta.status} ${respuesta.statusText}) al descargar ${url}.`;
    }
    const html = await respuesta.text();
    const colores = extraerColoresHex(html);
    const urlLogo = extraerUrlLogo(html, url);

    let lineaLogo = urlLogo ? `Logo/favicon encontrado: ${urlLogo}` : 'No se encontró favicon/logo/og:image en el HTML.';

    if (urlLogo && guardarLogoEn) {
        if (!rutaEstaAutorizada(guardarLogoEn, writePaths)) {
            lineaLogo += `\nNo se descargó: no tienes autoridad de escritura sobre '${guardarLogoEn}'.`;
        } else {
            try {
                const imgResp = await fetch(urlLogo, { signal: AbortSignal.timeout(15000) });
                if (imgResp.ok) {
                    const buffer = Buffer.from(await imgResp.arrayBuffer());
                    const rutaAbs = resolverRutaSegura(guardarLogoEn);
                    fs.mkdirSync(path.dirname(rutaAbs), { recursive: true });
                    fs.writeFileSync(rutaAbs, buffer);
                    lineaLogo += `\nDescargado y guardado en '${guardarLogoEn}'.`;
                } else {
                    lineaLogo += `\nNo se pudo descargar (${imgResp.status}).`;
                }
            } catch (err) {
                lineaLogo += `\nError al descargar: ${err.message}`;
            }
        }
    }

    const lineaColores = colores.length > 0
        ? `Colores hexadecimales más frecuentes en el HTML: ${colores.join(', ')}`
        : 'No se encontraron colores hexadecimales explícitos en el HTML (pueden estar en un archivo .css externo, no analizado aquí).';

    return `Análisis de marca de ${url}:\n\n${lineaLogo}\n\n${lineaColores}\n\nNota: estos colores vienen de lo que aparece literal en el HTML — si el sitio carga su CSS desde un archivo externo, puede que falten colores reales que solo viven ahí.`;
}

// Herramienta opcional: gateada por `email_access: true` en el playbook. Manda un correo real
// vía Resend. 🔴 SALVAGUARDA DE CARLOS (26 julio 2026): el envío a un destinatario real de
// verdad SOLO ocurre si ALLOW_REAL_EMAIL_SEND=true está en el entorno — sin eso, CUALQUIER
// intento de envío se redirige automáticamente a REVIEW_EMAIL (buzón de revisión de Carlos),
// con el destinatario y asunto reales visibles dentro del correo, para que pueda revisarlo
// antes de que le llegue de verdad a un prospecto. Mismo patrón de seguridad que ya se usa
// para bloquear Stripe en modo producción (ALLOW_STRIPE_LIVE_CHARGES).
const EMAIL_MONTHLY_LIMIT = 50;
const EMAIL_USAGE_FILE = path.join(VAULT_DIR, '.email-usage.json');
const verificarYRegistrarCorreo = () => verificarYRegistrarUso(EMAIL_USAGE_FILE, EMAIL_MONTHLY_LIMIT);

const EMAIL_TOOL = {
    name: 'send_email',
    description: 'Manda un correo real vía Resend, opcionalmente con una imagen adjunta (ej. una maqueta ya generada). Por seguridad, mientras no se autorice el envío real, SIEMPRE llega al buzón de revisión de Carlos en vez del destinatario que pidas, con el destinatario real y el asunto original visibles dentro del correo — no asumas que ya le llegó al destinatario real solo porque la herramienta devolvió éxito.',
    input_schema: {
        type: 'object',
        properties: {
            para: { type: 'string', description: 'Destinatario real deseado (el prospecto/persona a la que este correo está dirigido) — puede que no sea a quien realmente llegue, ver descripción de la herramienta.' },
            asunto: { type: 'string', description: 'Asunto del correo.' },
            cuerpo_html: { type: 'string', description: 'Cuerpo del correo en HTML simple (párrafos, negritas, links) — no uses CSS complejo ni JavaScript.' },
            adjuntar_imagen: { type: 'string', description: 'Ruta de una imagen YA generada (ej. vault/8-imagenes-generadas/creativa-balam/prospectos/{slug}/mockup.png) para adjuntarla al correo. Si la das, PON en tu cuerpo_html una etiqueta <img src="cid:imagen-embebida" style="max-width:100%"> en el lugar donde quieras que se vea la imagen dentro del cuerpo del correo (no solo como archivo aparte) — el cid es siempre literalmente "imagen-embebida", no inventes otro. Omitir el parámetro si no hay imagen que adjuntar.' },
        },
        required: ['para', 'asunto', 'cuerpo_html'],
    },
};

async function ejecutarSendEmail(paraReal, asunto, cuerpoHtml, adjuntarImagen) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        return 'RECHAZADO: RESEND_API_KEY no está configurada en el entorno — pide a un humano que cree una cuenta en resend.com y la agregue al .env del VPS.';
    }
    const chequeo = verificarYRegistrarCorreo();
    if (!chequeo.permitido) {
        return `RECHAZADO: límite mensual de ${EMAIL_MONTHLY_LIMIT} correos ya alcanzado (protección configurada por Carlos). Se reactiva el próximo mes.`;
    }

    const envioRealAutorizado = process.env.ALLOW_REAL_EMAIL_SEND === 'true';
    const remitente = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const bandejaRevision = process.env.REVIEW_EMAIL || 'balamcozu@proton.me';

    const destinatarioFinal = envioRealAutorizado ? paraReal : bandejaRevision;
    const asuntoFinal = envioRealAutorizado ? asunto : `[PRUEBA — destinatario real: ${paraReal}] ${asunto}`;
    const cuerpoFinal = envioRealAutorizado
        ? cuerpoHtml
        : `<p style="background:#fff3cd;padding:12px;border-radius:8px;color:#664d03;"><strong>⚠️ Correo de prueba.</strong> Este correo está redactado para <strong>${paraReal}</strong> pero se redirigió aquí porque el envío real todavía no está autorizado (ALLOW_REAL_EMAIL_SEND). Asunto real: "${asunto}".</p>${cuerpoHtml}`;

    // El adjunto es solo lectura de un archivo YA generado por generate_image en esta misma
    // corrida — no pasa por rutaEstaAutorizada porque no es una escritura, es adjuntar algo
    // que el propio agente ya tenía permiso de crear.
    let avisoAdjunto = '';
    const cuerpoPeticion = { from: remitente, to: destinatarioFinal, subject: asuntoFinal, html: cuerpoFinal };
    if (adjuntarImagen) {
        try {
            const rutaAbs = path.resolve(PROJECT_ROOT, adjuntarImagen);
            if (rutaAbs !== PROJECT_ROOT && !rutaAbs.startsWith(PROJECT_ROOT + path.sep)) {
                avisoAdjunto = `\nNo se adjuntó '${adjuntarImagen}': ruta fuera del proyecto.`;
            } else if (!fs.existsSync(rutaAbs)) {
                avisoAdjunto = `\nNo se adjuntó: '${adjuntarImagen}' no existe.`;
            } else {
                const contenidoB64 = fs.readFileSync(rutaAbs).toString('base64');
                // content_id fijo y predecible ('imagen-embebida') para que el agente pueda
                // referenciarla dentro del HTML como <img src="cid:imagen-embebida"> y se vea
                // la imagen dentro del cuerpo del correo, no solo como archivo aparte.
                cuerpoPeticion.attachments = [{ filename: path.basename(adjuntarImagen), content: contenidoB64, content_id: 'imagen-embebida' }];
            }
        } catch (err) {
            avisoAdjunto = `\nNo se adjuntó '${adjuntarImagen}': ${err.message}`;
        }
    }

    try {
        const respuesta = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpoPeticion),
            signal: AbortSignal.timeout(20000),
        });
        if (!respuesta.ok) {
            const errorTexto = await respuesta.text();
            return `ERROR (${respuesta.status}) enviando correo: ${errorTexto.slice(0, 500)}`;
        }
        const data = await respuesta.json();
        const conAdjunto = cuerpoPeticion.attachments ? ` Se adjuntó '${adjuntarImagen}'.` : avisoAdjunto;
        return (envioRealAutorizado
            ? `Correo enviado de verdad a ${paraReal} (id: ${data.id ?? 'sin id'}).`
            : `Correo de PRUEBA enviado a ${bandejaRevision} (no a ${paraReal} — el envío real no está autorizado todavía). id: ${data.id ?? 'sin id'}.`) + conAdjunto;
    } catch (err) {
        return `ERROR enviando correo: ${err.message}`;
    }
}

// Herramienta opcional: gateada por el MISMO `web_access: true` que fetch_url — no es una
// capacidad nueva de internet, es otra forma de mirar una página pública ya autorizada.
//
// Por qué una herramienta propia y no fetch_url: la API de PageSpeed devuelve un JSON de
// cientos de KB (el informe Lighthouse completo). fetch_url lo truncaría a 12k caracteres,
// dejando fuera justo los puntajes — y aunque cupiera, gastar todo el contexto del agente en
// JSON crudo para sacar 6 números es tirar tokens. Esta herramienta llama a la API y devuelve
// solo las métricas que importan, ya legibles.
//
// ⚠️ REQUIERE PAGESPEED_API_KEY. Verificado el 29 julio 2026 desde este VPS: sin key la API
// responde 429 con `quota_limit_value: "0"` — el acceso anónimo ya no existe, no es que esté
// "limitado". La key es gratis y sin tarjeta (Google Cloud Console → habilitar
// "PageSpeed Insights API" → crear credencial de API key), con 25,000 consultas/día.
const PAGESPEED_TOOL = {
    name: 'pagespeed_check',
    description: 'Mide el rendimiento real de una página web pública con Google PageSpeed Insights (Lighthouse) y devuelve sus puntajes (rendimiento, accesibilidad, buenas prácticas, SEO) y métricas de carga (LCP, CLS, TBT, FCP), además de las oportunidades de mejora más pesadas. Úsala para diagnosticar el sitio de un negocio con datos reales medidos, nunca estimes ni supongas estos números. Si le pasas guardar_crudo_en, además del resumen guarda el reporte COMPLETO de Lighthouse (las ~150 auditorías, no solo el resumen) y la captura de pantalla real del sitio medido, como archivos dentro de tus carpetas autorizadas.',
    input_schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'URL completa del sitio a medir, ej. https://ejemplo.com' },
            estrategia: {
                type: 'string',
                description: "'mobile' (por defecto, es como llega la mayoría del tráfico turístico) o 'desktop'.",
            },
            guardar_crudo_en: {
                type: 'string',
                description: "Ruta base (sin extensión), dentro de tus carpetas autorizadas, donde guardar el crudo completo -- ej. 'vault/9-auditoria-web/bacalar/crudos/casabakal-mobile'. Se le agrega '.json' (reporte completo de Lighthouse) y '.jpg' (captura de pantalla real, si Lighthouse la trae) automáticamente. Si no la pasas, solo obtienes el resumen y no se guarda nada.",
            },
        },
        required: ['url'],
    },
};

async function ejecutarPagespeedCheck(url, estrategia = 'mobile', guardarCrudoEn = null, writePaths = []) {
    const apiKey = process.env.PAGESPEED_API_KEY;
    if (!apiKey) {
        return 'RECHAZADO: PAGESPEED_API_KEY no está configurada en el entorno. Sin ella la API de Google responde 429 (el acceso anónimo tiene cuota 0). Pide a un humano que habilite "PageSpeed Insights API" en Google Cloud Console, cree una API key (gratis, sin tarjeta, 25000/día) y la agregue al .env del VPS. No intentes medir el sitio a mano con fetch_url — no da estos números.';
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return `RECHAZADO: '${url}' no es una URL válida.`;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        return `RECHAZADO: solo se permiten URLs http/https, no '${parsed.protocol}'.`;
    }
    const modo = estrategia === 'desktop' ? 'desktop' : 'mobile';
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('strategy', modo);
    endpoint.searchParams.set('key', apiKey);
    for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) {
        endpoint.searchParams.append('category', c);
    }
    try {
        // Lighthouse tarda de verdad: una medición real suele rondar 10-30s, y un sitio lento
        // (justo los que buscamos) puede pasar de 45s. Timeout generoso a propósito.
        const respuesta = await fetch(endpoint, { signal: AbortSignal.timeout(120000) });
        const data = await respuesta.json();
        if (!respuesta.ok) {
            const detalle = data?.error?.message || `${respuesta.status} ${respuesta.statusText}`;
            return `ERROR midiendo ${url}: ${detalle}`;
        }
        const lh = data.lighthouseResult;
        if (!lh) return `ERROR: PageSpeed no devolvió un informe para ${url}.`;

        const pct = (cat) => {
            const s = lh.categories?.[cat]?.score;
            return typeof s === 'number' ? Math.round(s * 100) : null;
        };
        const metrica = (id) => lh.audits?.[id]?.displayValue || 'n/d';
        const fmt = (v) => (v === null ? 'n/d' : `${v}/100`);

        // Oportunidades: auditorías que Lighthouse marca con ahorro real de tiempo. Se ordenan
        // por cuánto pesan y se dan las 5 mayores — son el argumento concreto de venta.
        const oportunidades = Object.values(lh.audits || {})
            .filter((a) => a?.details?.type === 'opportunity' && (a.details.overallSavingsMs || 0) > 0)
            .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
            .slice(0, 5)
            .map((a) => `  - ${a.title}: ahorro estimado ${Math.round(a.details.overallSavingsMs)} ms`);

        // Crudo: el resumen de arriba descarta ~145 de las ~150 auditorías de Lighthouse y
        // toda captura de pantalla -- si el agente pide guardarlo (guardar_crudo_en), se
        // persiste el reporte COMPLETO que Google regresó (data, no solo lh) más la captura
        // real del sitio (Lighthouse la trae en base64 dentro de audits['final-screenshot']).
        // Reportado por Carlos el 30 julio 2026: la auditoría de PageSpeed nunca dejaba
        // "los crudos" como sí hace prospección (crudo.md -> informes/); aquí no era que el
        // agente olvidara guardarlos, es que la herramienta nunca se los daba.
        const lineasCrudo = [];
        if (guardarCrudoEn) {
            if (!rutaEstaAutorizada(guardarCrudoEn, writePaths)) {
                lineasCrudo.push(`No se guardó el crudo: no tienes autoridad de escritura sobre '${guardarCrudoEn}'.`);
            } else {
                try {
                    const rutaJsonAbs = resolverRutaSegura(`${guardarCrudoEn}.json`);
                    fs.mkdirSync(path.dirname(rutaJsonAbs), { recursive: true });
                    fs.writeFileSync(rutaJsonAbs, JSON.stringify(data, null, 2), 'utf-8');
                    lineasCrudo.push(`Crudo completo (Lighthouse, ~150 auditorías) guardado en '${guardarCrudoEn}.json'.`);

                    const screenshotUri = lh.audits?.['final-screenshot']?.details?.data;
                    if (screenshotUri && screenshotUri.startsWith('data:image/')) {
                        const b64 = screenshotUri.split(',')[1];
                        if (b64) {
                            const rutaJpgAbs = resolverRutaSegura(`${guardarCrudoEn}.jpg`);
                            fs.writeFileSync(rutaJpgAbs, Buffer.from(b64, 'base64'));
                            lineasCrudo.push(`Captura real del sitio guardada en '${guardarCrudoEn}.jpg'.`);
                        }
                    } else {
                        lineasCrudo.push('Lighthouse no trajo captura de pantalla esta vez (pasa a veces, no es error).');
                    }
                } catch (err) {
                    lineasCrudo.push(`No se pudo guardar el crudo: ${err.message}`);
                }
            }
        }

        return [
            `PageSpeed (${modo}) para ${url}`,
            `Medido: ${lh.fetchTime || 'n/d'}`,
            '',
            `Rendimiento: ${fmt(pct('performance'))}`,
            `Accesibilidad: ${fmt(pct('accessibility'))}`,
            `Buenas prácticas: ${fmt(pct('best-practices'))}`,
            `SEO: ${fmt(pct('seo'))}`,
            '',
            `LCP (carga del contenido principal): ${metrica('largest-contentful-paint')}`,
            `FCP (primer contenido visible): ${metrica('first-contentful-paint')}`,
            `TBT (bloqueo de interacción): ${metrica('total-blocking-time')}`,
            `CLS (estabilidad visual): ${metrica('cumulative-layout-shift')}`,
            `Velocidad percibida: ${metrica('speed-index')}`,
            '',
            oportunidades.length ? `Oportunidades de mejora más pesadas:\n${oportunidades.join('\n')}` : 'Sin oportunidades de mejora destacadas.',
            ...(lineasCrudo.length ? ['', ...lineasCrudo] : []),
        ].join('\n');
    } catch (err) {
        return `ERROR midiendo ${url}: ${err.message}`;
    }
}

// Herramienta opcional: gateada por `search_access: true` en el playbook. A diferencia de
// fetch_url (que solo lee una URL que ya conoces), esta permite DESCUBRIR URLs nuevas — es
// el reemplazo real de "buscar en Google". Google/Bing/DuckDuckGo bloquean scraping directo
// desde este VPS (probado el 25 julio 2026: los tres devuelven captcha/bloqueo), así que se
// usa Serper.dev (API de resultados de Google real, ~$1 por 1000 búsquedas, 2500 gratis).
const SEARCH_TOOL = {
    name: 'search_web',
    description: 'Busca en Google (vía API de Serper) y devuelve título, link y snippet de los primeros resultados. Úsala para DESCUBRIR sitios/negocios que no conoces todavía — para leer el contenido completo de un resultado, después usa fetch_url sobre su link.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Términos de búsqueda, ej. "restaurantes en Mérida Yucatán"' },
        },
        required: ['query'],
    },
};

// Límite duro mensual — protección en código, no solo instrucción de prompt. Carlos pidió
// explícitamente no llevarse una sorpresa de gasto, tanto con Serper como con generación de
// imágenes. Función genérica: cada herramienta que gaste dinero real tiene su propio archivo
// contador y su propio límite, pero la lógica de "cuenta y corta" es la misma para todas.
function verificarYRegistrarUso(archivoContador, limiteMensual) {
    const mesActual = new Date().toISOString().slice(0, 7); // "2026-07"
    let uso = {};
    try {
        uso = JSON.parse(fs.readFileSync(archivoContador, 'utf-8'));
    } catch {
        uso = {};
    }
    const usadasEsteMes = uso[mesActual] || 0;
    if (usadasEsteMes >= limiteMensual) {
        return { permitido: false, usadas: usadasEsteMes };
    }
    uso[mesActual] = usadasEsteMes + 1;
    // Solo conservamos el mes actual y el anterior — no hace falta un historial creciente.
    const meses = Object.keys(uso).sort();
    const usoLimpio = Object.fromEntries(meses.slice(-2).map((m) => [m, uso[m]]));
    fs.writeFileSync(archivoContador, JSON.stringify(usoLimpio, null, 2));
    return { permitido: true, usadas: usadasEsteMes + 1 };
}

// search_web (Serper) — 300 búsquedas/mes, muy por debajo de las 2500 gratis de la cuenta.
// El diseño de los agentes ya usa Sección Amarilla como método principal (gratis), así que
// search_web es solo respaldo — en uso normal ni se acerca a este límite.
const SEARCH_MONTHLY_LIMIT = 300;
const SEARCH_USAGE_FILE = path.join(VAULT_DIR, '.search-usage.json');
const verificarYRegistrarBusqueda = () => verificarYRegistrarUso(SEARCH_USAGE_FILE, SEARCH_MONTHLY_LIMIT);

// generate_image (OpenAI) — 1000 imágenes/mes a calidad baja (~$5 USD tope real, fijado por
// Carlos el 26 julio 2026).
const IMAGE_MONTHLY_LIMIT = 1000;
const IMAGE_USAGE_FILE = path.join(VAULT_DIR, '.image-usage.json');
const verificarYRegistrarImagen = () => verificarYRegistrarUso(IMAGE_USAGE_FILE, IMAGE_MONTHLY_LIMIT);

async function ejecutarSearchWeb(query) {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
        return 'RECHAZADO: SERPER_API_KEY no está configurada en el entorno — pide a un humano que cree una cuenta en serper.dev y la agregue al .env del VPS.';
    }
    const chequeo = verificarYRegistrarBusqueda();
    if (!chequeo.permitido) {
        return `RECHAZADO: límite mensual de ${SEARCH_MONTHLY_LIMIT} búsquedas ya alcanzado (protección de costo configurada por Carlos). Se reactiva el próximo mes. No intentes compensar con fetch_url sobre buscadores — están bloqueados.`;
    }
    try {
        const respuesta = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, gl: 'mx', hl: 'es' }),
            signal: AbortSignal.timeout(15000),
        });
        if (!respuesta.ok) {
            return `ERROR (${respuesta.status}) buscando "${query}" en Serper.`;
        }
        const data = await respuesta.json();
        const resultados = (data.organic || []).slice(0, 10).map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet || ''}`
        );
        if (resultados.length === 0) {
            return `Sin resultados para "${query}".`;
        }
        return `Resultados para "${query}":\n\n${resultados.join('\n\n')}`;
    } catch (err) {
        return `ERROR buscando "${query}": ${err.message}`;
    }
}

// Herramienta opcional: gateada por `image_access: true` en el playbook. Genera una imagen real
// desde una descripción de texto (OpenAI gpt-image-1-mini) y la guarda como archivo dentro de
// las rutas autorizadas del agente (mismo mecanismo de permisos que write_file).
//
// Por defecto SIEMPRE usa el modelo mini en calidad baja (~$0.005/imagen) — Carlos pidió
// explícitamente "puro mini, a menos que se autoricen". Calidad alta / modelo completo
// (gpt-image-1) solo se habilita si el playbook del agente declara `image_hq_access: true`;
// si un agente sin ese permiso pide calidad alta, se le baja a mini/baja en silencio (con aviso
// en la respuesta) en vez de rechazar la tarea completa.
const IMAGE_GEN_TOOL = {
    name: 'generate_image',
    description: 'Genera una imagen real a partir de una descripción de texto y la guarda como archivo PNG. Por defecto usa el modelo económico en calidad baja — suficiente para íconos, banners simples y bocetos. Solo agentes con permiso especial pueden pedir calidad alta.',
    input_schema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Descripción detallada en inglés de la imagen a generar (mejor calidad que en español).' },
            ruta: { type: 'string', description: "Ruta relativa donde guardar el PNG, dentro de tus carpetas autorizadas, ej. 'vault/8-imagenes-generadas/gnga-web3/banner-lanzamiento.png'" },
            calidad: { type: 'string', enum: ['baja', 'alta'], description: "'baja' (default, barato) o 'alta' — 'alta' solo funciona si tu playbook tiene image_hq_access: true, si no se usa 'baja' automáticamente." },
        },
        required: ['prompt', 'ruta'],
    },
};

async function ejecutarGenerateImage(prompt, ruta, calidadPedida, writePaths, imageHqAccess) {
    if (!rutaEstaAutorizada(ruta, writePaths)) {
        return `RECHAZADO: no tienes autoridad de escritura sobre '${ruta}'. Rutas permitidas: ${writePaths.join(', ')}`;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return 'RECHAZADO: OPENAI_API_KEY no está configurada en el entorno — pide a un humano que la agregue al .env del VPS.';
    }
    const chequeo = verificarYRegistrarImagen();
    if (!chequeo.permitido) {
        return `RECHAZADO: límite mensual de ${IMAGE_MONTHLY_LIMIT} imágenes ya alcanzado (protección de costo configurada por Carlos). Se reactiva el próximo mes.`;
    }

    const quiereAlta = calidadPedida === 'alta';
    const autorizadoParaAlta = quiereAlta && imageHqAccess;
    const model = autorizadoParaAlta ? 'gpt-image-1' : 'gpt-image-1-mini';
    const quality = autorizadoParaAlta ? 'high' : 'low';
    const avisoDowngrade = quiereAlta && !autorizadoParaAlta
        ? ' (pediste calidad alta pero tu playbook no tiene image_hq_access: true — se generó en baja calidad en su lugar.)'
        : '';

    try {
        const respuesta = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, size: '1024x1024', quality, n: 1 }),
            signal: AbortSignal.timeout(60000),
        });
        if (!respuesta.ok) {
            const errorTexto = await respuesta.text();
            return `ERROR (${respuesta.status}) generando imagen: ${errorTexto.slice(0, 500)}`;
        }
        const data = await respuesta.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) {
            return `ERROR: OpenAI no devolvió una imagen válida. Respuesta: ${JSON.stringify(data).slice(0, 500)}`;
        }
        const rutaAbs = resolverRutaSegura(ruta);
        fs.mkdirSync(path.dirname(rutaAbs), { recursive: true });
        fs.writeFileSync(rutaAbs, Buffer.from(b64, 'base64'));
        return `Imagen guardada en '${ruta}' (modelo ${model}, calidad ${quality}).${avisoDowngrade}`;
    } catch (err) {
        return `ERROR generando imagen: ${err.message}`;
    }
}

// Herramientas opcionales: gateadas por `code_repo_access: true` en el playbook.
// A diferencia de write_file (limitado a vault/1-desk dentro de este mismo repo),
// estas operan sobre TOURBRAIN_APP_DIR — un repo de GitHub separado y real
// (Elpollomalo/tourbrain-app) que Vercel despliega automáticamente en cada push.
const CODE_REPO_TOOLS = [
    {
        name: 'list_code_files',
        description: 'Lista archivos y carpetas dentro del repo de código del proyecto TourBrain (tourbrain-app), en una ruta relativa a la raíz del repo.',
        input_schema: {
            type: 'object',
            properties: { ruta: { type: 'string', description: "Ruta relativa a la raíz del repo, ej. '.' o 'app/proveedores'" } },
            required: ['ruta'],
        },
    },
    {
        name: 'read_code_file',
        description: 'Lee el contenido completo de un archivo del repo de código de TourBrain (tourbrain-app).',
        input_schema: {
            type: 'object',
            properties: { ruta: { type: 'string', description: "Ruta relativa a la raíz del repo, ej. 'package.json'" } },
            required: ['ruta'],
        },
    },
    {
        name: 'write_code_file',
        description: 'Crea o sobreescribe un archivo real dentro del repo de código de TourBrain (tourbrain-app) — este es el proyecto Next.js que Vercel despliega en producción, no el vault interno.',
        input_schema: {
            type: 'object',
            properties: {
                ruta: { type: 'string', description: "Ruta relativa a la raíz del repo, ej. 'app/page.tsx'" },
                contenido: { type: 'string', description: 'Contenido completo a escribir en el archivo' },
            },
            required: ['ruta', 'contenido'],
        },
    },
    {
        name: 'commit_and_push_code',
        description: 'Hace commit de todos los cambios pendientes en el repo tourbrain-app y los sube (push) a la rama main en GitHub. Como el repo está conectado a Vercel, el push dispara un deploy automático. Úsalo al terminar un grupo de cambios relacionados, no después de cada archivo individual.',
        input_schema: {
            type: 'object',
            properties: { mensaje: { type: 'string', description: 'Mensaje de commit, descriptivo y en español, ej. "feat: layout base del sitio público"' } },
            required: ['mensaje'],
        },
    },
    {
        name: 'run_build',
        description: 'Corre "npm install && npm run build" de verdad sobre el repo tourbrain-app, y devuelve si compiló o no (con el error real si falló). Úsalo SIEMPRE antes de commit_and_push_code cuando hayas tocado código — muchos errores (tipos de TypeScript, imports rotos, opciones inválidas de una librería) solo se detectan compilando, no leyendo el código. Nota: variables de entorno que no existen en este entorno de prueba (ej. NEXT_PUBLIC_SUPABASE_URL) pueden hacer fallar el build por razones ajenas a tu código — si el error es claramente por una variable de entorno faltante y no por algo que tú escribiste, repórtalo así en vez de intentar arreglarlo.',
        input_schema: { type: 'object', properties: {}, required: [] },
    },
];

function resolverRutaCodigoSegura(rutaRelativa) {
    const root = process.env.TOURBRAIN_APP_DIR;
    if (!root) {
        throw new Error('TOURBRAIN_APP_DIR no configurado en el entorno.');
    }
    const rutaAbsoluta = path.resolve(root, rutaRelativa);
    if (rutaAbsoluta !== root && !rutaAbsoluta.startsWith(root + path.sep)) {
        throw new Error(`Ruta fuera del repo de código no permitida: ${rutaRelativa}`);
    }
    return rutaAbsoluta;
}

async function commitYPushCodigo(mensaje) {
    const root = process.env.TOURBRAIN_APP_DIR;
    if (!root) {
        return 'RECHAZADO: no hay TOURBRAIN_APP_DIR configurado en el entorno.';
    }
    try {
        await execFileAsync('git', ['add', '-A'], { cwd: root });
        try {
            await execFileAsync('git', ['commit', '-m', mensaje], { cwd: root });
        } catch (err) {
            const salida = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
            if (/nothing to commit/i.test(salida)) {
                return 'OK: no había cambios pendientes que commitear.';
            }
            throw err;
        }
        await execFileAsync('git', ['push', 'origin', 'main'], { cwd: root });
        return `OK: commit y push a main completados ("${mensaje}"). Vercel debería empezar el deploy automáticamente si el repo ya está conectado.`;
    } catch (err) {
        const salida = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
        return `ERROR git: ${salida.slice(0, 1000)}`;
    }
}

async function correrBuild() {
    const root = process.env.TOURBRAIN_APP_DIR;
    if (!root) {
        return 'RECHAZADO: no hay TOURBRAIN_APP_DIR configurado en el entorno.';
    }
    try {
        await execFileAsync('npm', ['install'], { cwd: root, timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
        const { stdout, stderr } = await execFileAsync('npm', ['run', 'build'], { cwd: root, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
        return `OK: el build compiló sin errores.\n${(stdout + stderr).slice(-1500)}`;
    } catch (err) {
        const salida = `${err.stdout || ''}\n${err.stderr || ''}`.trim() || err.message;
        if (err.killed || err.signal) {
            return `ERROR BUILD: el proceso se quedó colgado y fue detenido por timeout (probablemente una llamada de red bloqueada, ej. una API key de prueba inválida) — no es necesariamente un error de tu código. Salida parcial: ${salida.slice(-1000)}`;
        }
        return `ERROR BUILD:\n${salida.slice(-2500)}`;
    }
}

async function ejecutarAirtable(method, ruta, body) {
    if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
        return 'RECHAZADO: no hay AIRTABLE_PAT o AIRTABLE_BASE_ID configurados en el entorno.';
    }
    if (method === 'DELETE') {
        return 'RECHAZADO: el método DELETE es una operación destructiva. Requiere aprobación humana explícita fuera de este flujo automático — repórtala en tu respuesta final en vez de ejecutarla.';
    }
    const rutaResuelta = ruta.replace('{baseId}', process.env.AIRTABLE_BASE_ID).replace(/^\/+/, '');
    const url = `https://api.airtable.com/v0/${rutaResuelta}`;
    try {
        const respuesta = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const texto = await respuesta.text();
        if (!respuesta.ok) {
            return `ERROR AIRTABLE (${respuesta.status}): ${texto.slice(0, 1000)}`;
        }
        return `OK (${respuesta.status}). ${texto.slice(0, 1000)}`;
    } catch (err) {
        return `ERROR AIRTABLE: ${err.message}`;
    }
}

function resolverRutaSegura(rutaRelativa) {
    const rutaAbsoluta = path.resolve(PROJECT_ROOT, rutaRelativa);
    if (rutaAbsoluta !== PROJECT_ROOT && !rutaAbsoluta.startsWith(PROJECT_ROOT + path.sep)) {
        throw new Error(`Ruta fuera del proyecto no permitida: ${rutaRelativa}`);
    }
    return rutaAbsoluta;
}

// Mapea una ruta relativa del vault (ej. 'vault/5-bot-logs/tourbrain/2026-07-26.md')
// al enlace directo de FileBrowser, si esa ruta cae dentro de una de las
// carpetas que el compose de FileBrowser expone bajo /srv (ver
// /root/docker/filebrowser/docker-compose.yml). Si no cae en ninguna
// (ej. vault/1-desk, que es solo el resumen interno de la corrida y no está
// montado), regresa null — no todo entregable tiene que ser enlazable.
const FILEBROWSER_BASE_URL = 'https://archivos.creativabalam.com.mx/files';
const FILEBROWSER_MAPEOS = [
    ['vault/5-bot-logs/gnga-web3/reportes', 'bots/gnga-web3/reportes'],
    ['vault/5-bot-logs/gnga-web3', 'bots/gnga-web3/preguntas-log'],
    ['vault/5-bot-logs/tourbrain/reportes', 'bots/tourbrain/reportes'],
    ['vault/5-bot-logs/tourbrain', 'bots/tourbrain/preguntas-log'],
    ['vault/5-bot-logs/balam-website/reportes', 'bots/balam-website/reportes'],
    ['vault/5-bot-logs/balam-website/prospectos', 'bots/balam-website/prospectos'],
    ['vault/5-bot-logs/balam-website', 'bots/balam-website/preguntas-log'],
    ['vault/7-investigacion-mercado', 'investigacion-mercado'],
    ['vault/7-prospeccion-negocios', 'prospeccion-negocios'],
    ['vault/6-web-notes', 'revision-sitios'],
    ['vault/8-imagenes-generadas', 'imagenes-generadas'],
    ['vault/9-auditoria-web', 'auditoria-web'],
    ['vault/sources/creativa-balam/prospectos', 'marketing/prospectos-creativa-balam'],
].sort((a, b) => b[0].length - a[0].length); // más específico primero (ej. .../reportes antes que el padre)

function enlaceFileBrowser(rutaRelativaVault) {
    const normalizada = String(rutaRelativaVault || '').replace(/^\.\//, '').replace(/\/+$/, '');
    for (const [prefijoVault, prefijoSrv] of FILEBROWSER_MAPEOS) {
        if (normalizada === prefijoVault || normalizada.startsWith(`${prefijoVault}/`)) {
            const resto = normalizada.slice(prefijoVault.length);
            return `${FILEBROWSER_BASE_URL}/${prefijoSrv}${resto}`;
        }
    }
    return null;
}

function rutaEstaAutorizada(rutaRelativa, writePaths) {
    const normalizada = rutaRelativa.replace(/^\.\//, '').replace(/\/+$/, '');
    return writePaths.some((base) => normalizada === base || normalizada.startsWith(`${base}/`));
}

async function ejecutarTool(nombre, input, writePaths, dbAccess, codeRepoAccess, webAccess, searchAccess, imageAccess, imageHqAccess, emailAccess) {
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
        case 'run_airtable': {
            if (!dbAccess) {
                return 'RECHAZADO: este agente no tiene autoridad para usar Airtable (falta db_access: true en su playbook).';
            }
            return await ejecutarAirtable(input.method, input.ruta, input.body);
        }
        case 'list_code_files': {
            if (!codeRepoAccess) return 'RECHAZADO: este agente no tiene autoridad para operar sobre el repo de código (falta code_repo_access: true en su playbook).';
            const rutaAbs = resolverRutaCodigoSegura(input.ruta);
            if (!fs.existsSync(rutaAbs)) return `La ruta '${input.ruta}' no existe en el repo de código.`;
            const entradas = fs.readdirSync(rutaAbs, { withFileTypes: true });
            const listado = entradas.filter((e) => e.name !== '.git').map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
            return listado || '(carpeta vacía)';
        }
        case 'read_code_file': {
            if (!codeRepoAccess) return 'RECHAZADO: este agente no tiene autoridad para operar sobre el repo de código (falta code_repo_access: true en su playbook).';
            const rutaAbs = resolverRutaCodigoSegura(input.ruta);
            if (!fs.existsSync(rutaAbs)) return `El archivo '${input.ruta}' no existe en el repo de código.`;
            return fs.readFileSync(rutaAbs, 'utf-8');
        }
        case 'write_code_file': {
            if (!codeRepoAccess) return 'RECHAZADO: este agente no tiene autoridad para operar sobre el repo de código (falta code_repo_access: true en su playbook).';
            const rutaAbs = resolverRutaCodigoSegura(input.ruta);
            fs.mkdirSync(path.dirname(rutaAbs), { recursive: true });
            fs.writeFileSync(rutaAbs, input.contenido, 'utf-8');
            return `Archivo de código guardado en '${input.ruta}' (${input.contenido.length} caracteres).`;
        }
        case 'commit_and_push_code': {
            if (!codeRepoAccess) return 'RECHAZADO: este agente no tiene autoridad para operar sobre el repo de código (falta code_repo_access: true en su playbook).';
            return await commitYPushCodigo(input.mensaje);
        }
        case 'run_build': {
            if (!codeRepoAccess) return 'RECHAZADO: este agente no tiene autoridad para operar sobre el repo de código (falta code_repo_access: true en su playbook).';
            return await correrBuild();
        }
        case 'fetch_url': {
            if (!webAccess) return 'RECHAZADO: este agente no tiene autoridad para acceder a internet (falta web_access: true en su playbook).';
            return await ejecutarFetchUrl(input.url);
        }
        case 'pagespeed_check': {
            if (!webAccess) return 'RECHAZADO: este agente no tiene autoridad para acceder a internet (falta web_access: true en su playbook).';
            return await ejecutarPagespeedCheck(input.url, input.estrategia, input.guardar_crudo_en, writePaths);
        }
        case 'extract_site_branding': {
            if (!webAccess) return 'RECHAZADO: este agente no tiene autoridad para acceder a internet (falta web_access: true en su playbook).';
            return await ejecutarExtractBranding(input.url, input.guardar_logo_en, writePaths);
        }
        case 'search_web': {
            if (!searchAccess) return 'RECHAZADO: este agente no tiene autoridad para buscar en internet (falta search_access: true en su playbook).';
            return await ejecutarSearchWeb(input.query);
        }
        case 'generate_image': {
            if (!imageAccess) return 'RECHAZADO: este agente no tiene autoridad para generar imágenes (falta image_access: true en su playbook).';
            return await ejecutarGenerateImage(input.prompt, input.ruta, input.calidad, writePaths, imageHqAccess);
        }
        case 'send_email': {
            if (!emailAccess) return 'RECHAZADO: este agente no tiene autoridad para mandar correos (falta email_access: true en su playbook).';
            return await ejecutarSendEmail(input.para, input.asunto, input.cuerpo_html, input.adjuntar_imagen);
        }
        default:
            return `Herramienta desconocida: ${nombre}`;
    }
}

// Serializa jobs del MISMO proyecto (ej. dos tareas seguidas para 'tourbrain')
// para que nunca corran en paralelo sobre el mismo working directory de código
// (tourbrain-app es un único checkout compartido, no uno por job). Jobs de
// proyectos distintos sí pueden correr en paralelo, hasta WORKER_CONCURRENCY.
//
// Se descubrió el 24 julio 2026: dos jobs de 'tourbrain' corriendo casi a la
// vez hicieron que el run_build de uno viera archivos a medio escribir del
// otro (build falló por un módulo del otro job, sin dependencias instaladas
// todavía). No causó daño real esa vez, pero el riesgo de que se pisen
// archivos de verdad es serio.
const colasPorProyecto = new Map(); // proyecto (lowercase) -> promesa cola (nunca rechaza)

function ejecutarSerializadoPorProyecto(proyecto, tarea) {
    const clave = String(proyecto || '').toLowerCase();
    const colaAnterior = colasPorProyecto.get(clave) || Promise.resolve();
    const resultado = colaAnterior.then(tarea, tarea);
    // La cola guardada nunca debe rechazar — si lo hiciera, un job fallido
    // dejaría bloqueados a todos los siguientes del mismo proyecto para siempre.
    colasPorProyecto.set(clave, resultado.catch(() => {}));
    return resultado;
}

async function procesarJob(job) {
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
    const codeRepoAccess = /code_repo_access:\s*true/i.test(playbookContenido);
    const webAccess = /web_access:\s*true/i.test(playbookContenido);
    const searchAccess = /search_access:\s*true/i.test(playbookContenido);
    const imageAccess = /image_access:\s*true/i.test(playbookContenido);
    const imageHqAccess = /image_hq_access:\s*true/i.test(playbookContenido);
    const emailAccess = /email_access:\s*true/i.test(playbookContenido);
    let herramientas = dbAccess ? [...TOOLS, SQL_TOOL, AIRTABLE_TOOL] : [...TOOLS];
    if (codeRepoAccess) herramientas = [...herramientas, ...CODE_REPO_TOOLS];
    if (webAccess) herramientas = [...herramientas, WEB_FETCH_TOOL, BRAND_EXTRACT_TOOL, PAGESPEED_TOOL];
    if (searchAccess) herramientas = [...herramientas, SEARCH_TOOL];
    if (imageAccess) herramientas = [...herramientas, IMAGE_GEN_TOOL];
    if (emailAccess) herramientas = [...herramientas, EMAIL_TOOL];

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

    console.log(`🧠 Invocando a ${provider} usando el rol de ${agente} (modo ${modoCreativo ? 'creativo' : 'preciso'}, escritura: ${writePaths.join(', ') || 'ninguna'}, db_access: ${dbAccess}, code_repo_access: ${codeRepoAccess}, web_access: ${webAccess}, search_access: ${searchAccess}, image_access: ${imageAccess}, email_access: ${emailAccess}) para el proyecto ${proyecto}...`);

    const instruccionSQL = dbAccess
        ? '\n\nTambién tienes acceso a run_sql para ejecutar SQL real contra la base de datos de staging. Sentencias destructivas (DROP/DELETE/ALTER/TRUNCATE) son rechazadas automáticamente por el sistema; si necesitas una, repórtala en tu respuesta final para que un humano la revise, no intentes forzarla.\n\nTambién tienes acceso a run_airtable para llamar a la API REST de Airtable (schema y registros) contra la base configurada en AIRTABLE_BASE_ID. El método DELETE es rechazado automáticamente por el sistema; si necesitas uno, repórtalo en tu respuesta final para que un humano lo revise, no intentes forzarlo.'
        : '';

    const instruccionCodigo = codeRepoAccess
        ? '\n\nTambién tienes acceso a list_code_files, read_code_file, write_code_file, run_build y commit_and_push_code para operar sobre el repo de código real de tourbrain-app (proyecto Next.js, GitHub: Elpollomalo/tourbrain-app, desplegado en Vercel). A diferencia de write_file (que solo escribe en vault/1-desk de este repo interno), estos archivos son el producto real que se publica en producción — escribe código completo y funcional, no pseudocódigo ni descripciones. OBLIGATORIO: corre run_build después de escribir/modificar código y ANTES de commit_and_push_code — leer el código no basta para detectar errores de tipos, imports rotos u opciones inválidas de una librería, solo compilar de verdad los detecta. Si run_build falla por algo que tú escribiste, corrígelo y vuelve a correrlo hasta que compile antes de subir. Si falla por algo ajeno a tu código (ej. una variable de entorno que no existe en este entorno de prueba), repórtalo explícitamente en tu resumen en vez de intentar arreglarlo o de subir código sin haber podido confirmar que compila. Usa commit_and_push_code al terminar un grupo de cambios relacionados y funcionales (no después de cada archivo suelto), con un mensaje de commit descriptivo. Un push a main dispara un deploy automático en Vercel si el repo ya está conectado — no asumas que un push equivale a que el sitio ya esté en línea con el dominio final, eso depende de configuración adicional fuera de tu alcance (ver house rules).'
        : '';

    const instruccionWeb = webAccess
        ? '\n\nTambién tienes acceso a fetch_url para descargar el contenido real (texto plano) de cualquier URL pública. Úsala para leer páginas web reales en vez de suponer qué dicen — especialmente cuando tu tarea te pida revisar el sitio en producción de un proyecto. Cada URL a visitar cuenta como una llamada por separado.\n\nTambién tienes acceso a extract_site_branding para sacar el logo/favicon real y los colores hexadecimales que usa un sitio (a diferencia de fetch_url, que solo da texto plano sin colores ni imágenes). Úsala sobre el sitio de un prospecto antes de escribirle una propuesta o generarle una maqueta — así usas su identidad visual real en vez de inventar una. Si le pasas guardar_logo_en, descarga el logo/favicon encontrado como archivo dentro de tus carpetas autorizadas.\n\nTambién tienes acceso a pagespeed_check para medir el rendimiento real de un sitio con Google PageSpeed Insights (Lighthouse) y obtener sus puntajes y tiempos de carga reales. Cada medición tarda entre 10 y 60 segundos, así que mide un sitio a la vez y no re-midas el mismo sitio dos veces en la misma tarea. Nunca estimes ni inventes estos números: si la herramienta falla para un sitio, di que falló y por qué, en vez de escribir un puntaje supuesto. Si le pasas guardar_crudo_en, además del resumen guarda el reporte COMPLETO de Lighthouse y la captura real del sitio como archivos aparte dentro de tus carpetas autorizadas — tu playbook te dirá si debes usarlo siempre o no.'
        : '';

    const instruccionSearch = searchAccess
        ? '\n\nTambién tienes acceso a search_web para buscar en Google de verdad (vía Serper) y descubrir sitios/negocios que no conoces todavía — no inventes nombres de negocios ni URLs, búscalos primero. Después de encontrar un resultado relevante, usa fetch_url sobre su link si necesitas el contenido completo de esa página.'
        : '';

    const instruccionImagen = imageAccess
        ? `\n\nTambién tienes acceso a generate_image para crear una imagen real desde una descripción de texto y guardarla como PNG dentro de tus rutas autorizadas. Escribe el prompt en inglés (mejor calidad). Por defecto se genera en calidad baja/económica — no pidas calidad "alta" salvo que la tarea te lo pida explícitamente, y aun así solo funciona si tu playbook tiene image_hq_access${imageHqAccess ? ' (SÍ lo tienes)' : ' (NO lo tienes — cualquier solicitud de calidad alta se genera en baja automáticamente)'}.`
        : '';

    const instruccionEmail = emailAccess
        ? '\n\nTambién tienes acceso a send_email para mandar un correo real vía Resend. Si adjuntas una imagen con adjuntar_imagen, no basta con mencionarla en el texto — pon <img src="cid:imagen-embebida" style="max-width:100%"> en tu cuerpo_html donde quieras que se vea, así queda visible dentro del correo, no solo como archivo aparte. 🔴 IMPORTANTE: mientras el envío real no esté autorizado por Carlos, el correo NUNCA llega al destinatario real que pongas — se redirige automáticamente a un buzón de revisión, con el destinatario y asunto reales marcados adentro. No reportes en tu resumen que "el correo ya le llegó al prospecto" — repórtalo como lo que es: un correo de prueba enviado al buzón de revisión, pendiente de que Carlos lo revise y autorice el envío real.'
        : '';

    // Bloque estático (idéntico para todas las tareas de este agente): se marca con
    // cache_control para que la API lo cachee entre turnos de una misma corrida y entre
    // corridas distintas del mismo rol, en vez de volver a cobrarlo entero cada vez.
    const systemEstatico = `Eres un agente de IA especializado que forma parte de una organización virtual.
        Debes actuar estrictamente bajo los siguientes estatutos y playbooks.
        Tienes acceso a herramientas (list_files, read_file, write_file) para operar sobre el filesystem real del vault. Úsalas para cumplir tu misión: no te limites a describir lo que harías, hazlo.
        write_file solo funciona dentro de tus rutas autorizadas: ${writePaths.join(', ') || 'ninguna'}. Cualquier intento fuera de esas rutas será rechazado automáticamente.${instruccionVoz}${instruccionSQL}${instruccionCodigo}${instruccionWeb}${instruccionSearch}${instruccionImagen}${instruccionEmail}

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

            // max_tokens alto (32000) necesita streaming — sin esto, un documento largo
            // se puede cortar por timeout HTTP antes de que el modelo termine (mismo bug
            // que ya se había corregido del lado de Claude, pero nunca se aplicó aquí:
            // se detectó porque un documento largo se quedó con finish_reason 'length'
            // a los 16000 tokens sin streaming).
            const respuesta = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                },
                body: JSON.stringify({
                    model: 'deepseek-v4-flash',
                    max_tokens: 32000,
                    stream: true,
                    messages: messagesDS,
                    tools: herramientasDS,
                }),
            });

            if (!respuesta.ok) {
                const errorTexto = await respuesta.text();
                throw new Error(`DeepSeek ${respuesta.status}: ${errorTexto}`);
            }

            // Acumula el stream SSE (formato compatible con OpenAI) en un solo
            // mensaje final, igual que hace el SDK de Anthropic por debajo.
            let contenidoAcumulado = '';
            let finishReason = null;
            const toolCallsAcumulados = [];
            const reader = respuesta.body.getReader();
            const decoder = new TextDecoder();
            let bufferSSE = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bufferSSE += decoder.decode(value, { stream: true });
                const lineas = bufferSSE.split('\n');
                bufferSSE = lineas.pop(); // línea incompleta, se guarda para el siguiente chunk

                for (const linea of lineas) {
                    if (!linea.startsWith('data: ')) continue;
                    const payload = linea.slice(6).trim();
                    if (payload === '[DONE]') continue;

                    const evento = JSON.parse(payload);
                    const delta = evento.choices[0].delta;
                    if (evento.choices[0].finish_reason) finishReason = evento.choices[0].finish_reason;
                    if (delta.content) contenidoAcumulado += delta.content;

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (!toolCallsAcumulados[tc.index]) {
                                toolCallsAcumulados[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                            }
                            const acumulado = toolCallsAcumulados[tc.index];
                            if (tc.id) acumulado.id = tc.id;
                            if (tc.function?.name) acumulado.function.name += tc.function.name;
                            if (tc.function?.arguments) acumulado.function.arguments += tc.function.arguments;
                        }
                    }
                }
            }

            const mensajeCompleto = {
                role: 'assistant',
                content: contenidoAcumulado || null,
                tool_calls: toolCallsAcumulados.length ? toolCallsAcumulados : undefined,
            };

            console.log(`↳ [${agente}] turno ${turnos} — finish_reason: ${finishReason}`);

            if (finishReason === 'length') {
                agotoTokens = true;
                console.warn(`⚠️ [${agente}] se quedó sin tokens de salida a media respuesta (turno ${turnos}).`);
            }

            if (finishReason !== 'tool_calls') {
                resultadoIA = mensajeCompleto.content || resultadoIA;
                break;
            }

            messagesDS.push(mensajeCompleto);

            for (const toolCall of mensajeCompleto.tool_calls) {
                const input = JSON.parse(toolCall.function.arguments);
                console.log(`🔧 [${agente}] invoca '${toolCall.function.name}':`, JSON.stringify(input));

                let resultado;
                try {
                    resultado = await ejecutarTool(toolCall.function.name, input, writePaths, dbAccess, codeRepoAccess, webAccess, searchAccess, imageAccess, imageHqAccess, emailAccess);
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

            // max_tokens alto (64000) necesita streaming — sin esto, el SDK puede
            // cortar la petición por timeout HTTP antes de que el modelo termine
            // de generar una respuesta larga (nos pasó con 16000 sin streaming:
            // el modelo se quedaba sin tokens a medio entregable).
            const streamRespuesta = anthropic.messages.stream({
                model: 'claude-sonnet-5',
                max_tokens: 64000,
                system: systemPrompt,
                tools: herramientas,
                messages,
            });
            ultimaRespuesta = await streamRespuesta.finalMessage();

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
                    resultado = await ejecutarTool(bloque.name, bloque.input, writePaths, dbAccess, codeRepoAccess, webAccess, searchAccess, imageAccess, imageHqAccess, emailAccess);
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

    // Entregables reales enlazables en FileBrowser (no el resumen interno de
    // vault/1-desk) — cualquier write_file/generate_image que haya tenido
    // éxito y caiga dentro de una carpeta expuesta por FileBrowser. Carlos
    // pidió esto explícitamente (26 julio 2026): poder entrar desde
    // FileBrowser al reporte/entregable real que avisa Telegram.
    const enlacesEntregables = [...new Set(
        bitacoraHerramientas
            .filter((b) => (b.herramienta === 'write_file' || b.herramienta === 'generate_image') && !String(b.resultado).startsWith('RECHAZADO'))
            .map((b) => enlaceFileBrowser(b.input.ruta))
            .filter(Boolean),
    )];

    return {
        status: 'success',
        archivoGenerado: nombreArchivoSalida,
        herramientasInvocadas: bitacoraHerramientas.length,
        enlacesEntregables,
    };
}

// Qué produce cada agente, en lenguaje humano. El nombre técnico del agente
// ("marketing", "auditoria-web") no le dice nada a Carlos cuando le llega el
// aviso al celular — pidió explícitamente saber de qué es cada cron
// (30 julio 2026: "hay informes que no puedo leer y no sé de qué son").
// Un agente sin entrada aquí cae a su propio nombre, no rompe nada.
const DESCRIPCION_AGENTE = {
    'marketing': '🌐 Revisión del sitio en producción',
    'prospectores': '🔎 Búsqueda de negocios (crudo)',
    'informes-prospeccion': '📋 Informe de negocios prospectados',
    'auditoria-web': '⚡ Auditoría de velocidad de sitios (PageSpeed)',
    'auditoria-bots': '🤖 Auditoría de los bots de chat',
    'investigadores': '📚 Investigación de mercado',
    'disenadores': '🎨 Propuesta de diseño',
    'programadores-borrador': '💻 Código (borrador, sin subir)',
    'programadores-revision': '🔍 Revisión de código',
    'criticos': '🧐 Revisión crítica',
    'editores': '✍️ Edición de texto',
    'auditoria': '🗂️ Auditoría de coherencia del vault',
    'catalogadores': '🏷️ Catalogación',
    'cartografos': '🗺️ Mapeo de información',
    'scouts': '🛰️ Recolección de fuentes',
};

function etiquetaAgente(agente) {
    return DESCRIPCION_AGENTE[agente] || agente || '?';
}

const worker = new Worker('cola-de-agentes', (job) => ejecutarSerializadoPorProyecto(job.data.proyecto, () => procesarJob(job)), { connection, concurrency: WORKER_CONCURRENCY });

worker.on('completed', (job) => {
    console.log(`✅ Tarea ${job.id} procesada con éxito por la IA.`);
    const { agente, proyecto } = job.data || {};
    const archivo = job.returnvalue?.archivoGenerado;
    const enlaces = job.returnvalue?.enlacesEntregables || [];
    let mensaje = `✅ ${etiquetaAgente(agente)}\nProyecto: ${proyecto || '?'} · tarea ${job.id}`;
    if (enlaces.length) {
        // Máximo 3 para no mandar un mensaje gigante si el agente escribió muchos archivos.
        mensaje += `\n${enlaces.slice(0, 3).join('\n')}`;
    } else if (archivo) {
        // Sin entregable enlazable: el resumen interno de la corrida vive en
        // vault/1-desk, que a propósito no se expone en FileBrowser (es la
        // bitácora del agente, no un informe para leer). Se dice explícitamente
        // en vez de dejar una ruta suelta que parece un link roto.
        mensaje += `\nSin informe publicado — solo bitácora interna (vault/1-desk/${archivo})`;
    }
    notificar(mensaje);
});
worker.on('failed', (job, err) => {
    console.error(`❌ Tarea ${job.id} falló de forma crítica:`, err.message);
    const { agente, proyecto } = job?.data || {};
    notificar(`❌ ${etiquetaAgente(agente)}\nProyecto: ${proyecto || '?'} · tarea ${job?.id}\nFalló: ${err.message}`);
});
