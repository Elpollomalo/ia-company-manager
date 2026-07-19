const { Worker } = require('bullmq');
const { connection } = require('./config');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

console.log("🤖 El Orquestador 'ia-company-manager' está en línea y conectado con la API de Claude...");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const worker = new Worker('cola-de-agentes', async (job) => {
    const { agente, proyecto, tarea, archivoOrigen } = job.data;
    console.log(`\n⚡ Procesando: Agente [${agente}] | Proyecto [${proyecto}]`);

    const playbookPath = path.join(__dirname, 'agents', `${agente}.md`);
    const houseRulesPath = path.join(__dirname, 'house-rules.md');
    const sourcesPath = path.join(__dirname, 'vault', 'sources', `${proyecto.toLowerCase()}.md`);

    if (!fs.existsSync(playbookPath)) {
        throw new Error(`El playbook para el agente '${agente}' no existe.`);
    }

    const houseRules = fs.readFileSync(houseRulesPath, 'utf-8');
    const playbook = fs.readFileSync(playbookPath, 'utf-8');

    let proyectoContexto = "No hay un archivo de contexto específico en sources/ todavía.";
    if (fs.existsSync(sourcesPath)) {
        proyectoContexto = fs.readFileSync(sourcesPath, 'utf-8');
    }

    console.log(`🧠 Invocando a Claude usando el rol de ${agente} para el proyecto ${proyecto}...`);

    const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        temperature: 0, // Temperatura 0 para evitar alucinaciones y forzar respuestas precisas
        system: `Eres un agente de IA especializado que forma parte de una organización virtual.
        Debes actuar estrictamente bajo los siguientes estatutos y playbooks.

        === ESTATUTOS DEL SISTEMA (HOUSE RULES) ===
        ${houseRules}

        === TU PLAYBOOK DE ROL ===
        ${playbook}

        === CONTEXTO DEL PROYECTO ACTUAL ===
        ${proyectoContexto}`,
        messages: [
            { role: "user", content: `Ejecuta la siguiente tarea de forma estricta: ${tarea}` }
        ],
    });

    const resultadoIA = response.content[0].text;

    // Guardamos la salida del agente en el espacio temporal de trabajo
    const nombreArchivoSalida = `${agente}_${proyecto.toLowerCase()}_${job.id}.md`;
    const rutaSalida = path.join(__dirname, 'vault', '1-desk', nombreArchivoSalida);

    fs.writeFileSync(rutaSalida, resultadoIA, 'utf-8');
    console.log(`💾 Resultado guardado en de forma temporal en: vault/1-desk/${nombreArchivoSalida}`);

    return { status: 'success', archivoGenerado: nombreArchivoSalida };
}, { connection });

worker.on('completed', (job) => console.log(`✅ Tarea ${job.id} procesada con éxito por la IA.`));
worker.on('failed', (job, err) => console.error(`❌ Tarea ${job.id} falló de forma crítica:`, err.message));
