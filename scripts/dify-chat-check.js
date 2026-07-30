#!/usr/bin/env node
// Le manda preguntas de prueba a un bot de Dify (Chat Messages API) y
// muestra las respuestas reales, para que un humano (o el agente
// `auditoria` más adelante) revise si el bot está respondiendo bien —
// nunca decide solo si algo "pasó" o "falló", solo junta la evidencia.
//
// Uso:
//   node scripts/dify-chat-check.js <proyecto>                  → corre la batería de preguntas de auditoría
//   node scripts/dify-chat-check.js <proyecto> "<pregunta>"      → manda una sola pregunta puntual
//
// Requiere en .env (API key de la App/Chatflow, DISTINTA a la del Dataset):
//   DIFY_CHAT_API_KEY_<PROYECTO>   (ej: DIFY_CHAT_API_KEY_GNGA_WEB3) → si no está, usa DIFY_CHAT_API_KEY
//   DIFY_BASE_URL_<PROYECTO> / DIFY_BASE_URL   → opcional, default https://api.dify.ai/v1

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PREGUNTAS_AUDITORIA = {
    'gnga-web3': [
        '¿Cómo compro $GNGA?',
        '¿Tienen algún juego, casino, lotería o tragamonedas?',
        '¿Qué es el Vault?',
        '¿Tienen página web?',
    ],
    'tourbrain': [
        'Can you recommend a good restaurant in Cozumel?',
        '¿Qué tours de snorkel o buceo tienen disponibles?',
        'Where are you located?',
        '¿Cómo hago una reserva?',
        'Do you have any nightlife or bar recommendations?',
    ],
    'balam-website': [
        '¿Qué servicios ofrecen?',
        '¿Cuánto cuesta un sitio web?',
        'Quiero contactarlos, ¿cómo le hago?',
        'What services do you offer?',
        '¿Tienen experiencia con apps de reservas o catálogos?',
    ],
};

// TourBrain necesita el input "destino" para que el nodo HTTP del Chatflow
// traiga el catalogo de una ciudad -- sin esto responde honestamente "falta
// indicar la ciudad" y una corrida de auditoria completa se ve como "todo
// roto" sin serlo (paso real el 30 julio 2026, casi lleva a diagnosticar mal
// un bug de otro tipo). Los demas bots no usan destino, así que no lo necesitan.
const INPUTS_POR_PROYECTO = {
    'tourbrain': { destino: 'cozumel' },
};

const VAULT_LOGS_DIR = path.join(__dirname, '..', 'vault', '5-bot-logs');

// Un agente (ej. investigadores, con web_access) puede investigar qué
// preguntaría un cliente real y el protocolo del negocio, y dejar su
// propuesta aquí -- una pregunta por línea, sin numeración ni viñetas. Si
// existe y trae al menos una línea real, se usa en vez de la lista fija de
// abajo. Pedido por Carlos el 30 julio 2026: "que se manden las mismas
// preguntas es una cosa que no sirve, no sirve para hacer un verdadero
// análisis" -- la lista fija queda solo como respaldo si nunca se ha
// investigado nada para ese proyecto.
function leerPreguntasPropuestas(proyecto) {
    const ruta = path.join(VAULT_LOGS_DIR, proyecto.toLowerCase(), 'preguntas-propuestas.md');
    if (!fs.existsSync(ruta)) return null;
    const lineas = fs.readFileSync(ruta, 'utf-8')
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter((l) => l && !l.startsWith('#'));
    return lineas.length > 0 ? lineas : null;
}

function slugEntorno(proyecto) {
    return proyecto.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function variableProyecto(proyecto, sufijo, valorPorDefecto) {
    const slug = slugEntorno(proyecto);
    return process.env[`${sufijo}_${slug}`] || process.env[sufijo] || valorPorDefecto;
}

async function preguntar(baseUrl, apiKey, pregunta, inputs) {
    const respuesta = await fetch(`${baseUrl}/chat-messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            inputs: inputs || {},
            query: pregunta,
            response_mode: 'blocking',
            user: 'auditoria-ia-company-manager',
        }),
    });
    if (!respuesta.ok) {
        const errorTexto = await respuesta.text();
        throw new Error(`Dify ${respuesta.status}: ${errorTexto}`);
    }
    const json = await respuesta.json();
    return json.answer;
}

async function main() {
    const proyecto = process.argv[2];
    const preguntaUnica = process.argv[3];
    if (!proyecto) {
        console.error('Uso: node scripts/dify-chat-check.js <proyecto> ["<pregunta>"]');
        process.exit(1);
    }

    const apiKey = variableProyecto(proyecto, 'DIFY_CHAT_API_KEY');
    const baseUrl = variableProyecto(proyecto, 'DIFY_BASE_URL', 'https://api.dify.ai/v1');
    if (!apiKey) {
        const slug = slugEntorno(proyecto);
        console.error(`Falta la API key de Chat de Dify para '${proyecto}' — pon DIFY_CHAT_API_KEY_${slug} (o DIFY_CHAT_API_KEY genérica) en .env. Es la API key de la App/Chatflow (API Access de la App), NO la del Dataset.`);
        process.exit(1);
    }

    const propuestas = leerPreguntasPropuestas(proyecto);
    const preguntas = preguntaUnica ? [preguntaUnica] : (propuestas || PREGUNTAS_AUDITORIA[proyecto] || []);
    if (preguntas.length === 0) {
        console.error(`No hay preguntas de auditoría predefinidas para '${proyecto}' y no diste una pregunta puntual.`);
        process.exit(1);
    }
    if (propuestas && !preguntaUnica) {
        console.log(`(usando ${propuestas.length} preguntas propuestas por un agente en preguntas-propuestas.md, no la lista fija)`);
    }

    const inputs = INPUTS_POR_PROYECTO[proyecto];

    console.log(`🔎 Probando el bot de '${proyecto}' con ${preguntas.length} pregunta(s)...\n`);

    const ahora = new Date();
    const lineasLog = [`## Corrida ${ahora.toISOString()}`, ''];

    for (const pregunta of preguntas) {
        console.log(`❓ ${pregunta}`);
        lineasLog.push(`**❓ ${pregunta}**`, '');
        try {
            const respuesta = await preguntar(baseUrl, apiKey, pregunta, inputs);
            console.log(`🐿️ ${respuesta}\n`);
            lineasLog.push(respuesta, '');
        } catch (err) {
            console.error(`✗ Error: ${err.message}\n`);
            lineasLog.push(`✗ Error: ${err.message}`, '');
        }
    }

    // Solo se registra en el log si fue la batería completa de auditoría —
    // una pregunta puntual (segundo argumento) es exploración manual, no auditoría.
    if (!preguntaUnica) {
        const carpetaProyecto = path.join(VAULT_LOGS_DIR, proyecto.toLowerCase());
        fs.mkdirSync(carpetaProyecto, { recursive: true });
        const fecha = ahora.toISOString().slice(0, 10);
        const rutaLog = path.join(carpetaProyecto, `${fecha}.md`);
        fs.appendFileSync(rutaLog, lineasLog.join('\n') + '\n---\n\n');
        console.log(`📝 Registrado en vault/5-bot-logs/${proyecto.toLowerCase()}/${fecha}.md`);
    }
}

main().catch((err) => {
    console.error('Fallo probando el bot:', err.message);
    process.exit(1);
});
