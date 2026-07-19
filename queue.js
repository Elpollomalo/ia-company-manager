const { Queue } = require('bullmq');
const { connection } = require('./config');

const colaAgentes = new Queue('cola-de-agentes', { connection });

async function agregarTarea(agente, proyecto, tarea, datos = {}) {
    const job = await colaAgentes.add(`tarea-${agente}`, {
        agente,
        proyecto,
        tarea,
        ...datos
    });
    console.log(`🚀 Tarea enviada a la cola Redis con ID: ${job.id}`);
}

module.exports = { agregarTarea };
