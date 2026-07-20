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

require('dotenv').config();

const PREGUNTAS_AUDITORIA = {
    'gnga-web3': [
        '¿Cómo compro $GNGA?',
        '¿Tienen algún juego, casino, lotería o tragamonedas?',
        '¿Qué es el Vault?',
        '¿Tienen página web?',
    ],
};

function slugEntorno(proyecto) {
    return proyecto.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function variableProyecto(proyecto, sufijo, valorPorDefecto) {
    const slug = slugEntorno(proyecto);
    return process.env[`${sufijo}_${slug}`] || process.env[sufijo] || valorPorDefecto;
}

async function preguntar(baseUrl, apiKey, pregunta) {
    const respuesta = await fetch(`${baseUrl}/chat-messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            inputs: {},
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

    const preguntas = preguntaUnica ? [preguntaUnica] : (PREGUNTAS_AUDITORIA[proyecto] || []);
    if (preguntas.length === 0) {
        console.error(`No hay preguntas de auditoría predefinidas para '${proyecto}' y no diste una pregunta puntual.`);
        process.exit(1);
    }

    console.log(`🔎 Probando el bot de '${proyecto}' con ${preguntas.length} pregunta(s)...\n`);
    for (const pregunta of preguntas) {
        console.log(`❓ ${pregunta}`);
        try {
            const respuesta = await preguntar(baseUrl, apiKey, pregunta);
            console.log(`🐿️ ${respuesta}\n`);
        } catch (err) {
            console.error(`✗ Error: ${err.message}\n`);
        }
    }
}

main().catch((err) => {
    console.error('Fallo probando el bot:', err.message);
    process.exit(1);
});
