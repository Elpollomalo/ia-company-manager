const { Queue } = require('bullmq');
const { connection } = require('./config');

const colaAgentes = new Queue('cola-de-agentes', { connection });

async function check(ids) {
  const results = [];
  for (const id of ids) {
    const job = await colaAgentes.getJob(String(id));
    if (!job) {
      results.push(`Job ${id}: no encontrado`);
      continue;
    }
    const state = await job.getState();
    results.push(`Job ${id}: ${state}`);
  }
  console.log(results.join(' | '));
  process.exit(0);
}

check(process.argv.slice(2));
