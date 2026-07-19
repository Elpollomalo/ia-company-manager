const { Queue } = require('bullmq');
const { connection } = require('./config');

const colaAgentes = new Queue('cola-de-agentes', { connection });

async function agregarTarea(agente, proyecto, tarea, datos = {}) {
    const job = await colaAgentes.add(`tarea-${agente}`, {
        agente,
        proyecto,
        tarea,
        ...datos
    }, {
        // Reintenta fallos transitorios (429, timeouts, 5xx) — sin esto, un hiccup
        // momentáneo de la API mata la tarea para siempre en vez de reintentarla.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
    });
    console.log(`🚀 Tarea enviada a la cola Redis con ID: ${job.id}`);
}

module.exports = { agregarTarea };
