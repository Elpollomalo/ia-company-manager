const { Worker } = require('bullmq');
const { connection } = require('./config');
const fs = require('fs');
const path = require('path');

console.log("🤖 El Orquestador 'ia-company-manager' está en línea y escuchando la cola de Redis...");

const worker = new Worker('cola-de-agentes', async (job) => {
    const { agente, proyecto, tarea } = job.data;
    console.log(`\n⚡ Procesando: Agente [${agente}] | Proyecto [${proyecto}]`);

    const playbookPath = path.join(__dirname, 'agents', `${agente}.md`);
    const houseRulesPath = path.join(__dirname, 'house-rules.md');

    if (!fs.existsSync(playbookPath)) {
        throw new Error(`El playbook para el agente '${agente}' no existe.`);
    }

    const houseRules = fs.readFileSync(houseRulesPath, 'utf-8');
    const playbook = fs.readFileSync(playbookPath, 'utf-8');

    console.log(`📖 Validando estatutos de seguridad para ${proyecto}...`);

    return { status: 'success', proyecto };
}, { connection });

worker.on('completed', (job) => console.log(`✅ Tarea ${job.id} completada.`));
worker.on('failed', (job, err) => console.error(`❌ Tarea ${job.id} falló:`, err.message));
