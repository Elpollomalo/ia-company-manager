#!/usr/bin/env node
/**
 * SEGUIMIENTO DE CAMPAÑA — PIPELINE DE PROSPECCIÓN
 *
 * CRM ligero en un solo JSON. Registra el ciclo completo de cada prospecto
 * contactado: enviado -> respondió -> cita -> cerrado/perdido, y calcula
 * las métricas que hacen falta para saber si la campaña funciona.
 *
 * Archivo: /root/agente-constructor/prospeccion-diaria/seguimiento.json
 * Estructura: { "correo@dominio.com": { ...registro... }, ... }
 *
 * Estados del embudo (en orden):
 *   enviado -> respondio -> cita_agendada -> cerrado_ganado
 *                                          -> cerrado_perdido
 *   (o en cualquier punto: sin_respuesta si pasan >14 dias sin novedad)
 *
 * Uso:
 *   node seguimiento.js sincronizar          -> importa TODOS los envios de Resend
 *                                                (tandas manuales + diarias) como base
 *   node seguimiento.js marcar <correo> <estado> [--monto N] [--nota "texto"]
 *   node seguimiento.js estadisticas         -> resumen del embudo completo
 *   node seguimiento.js pendientes           -> quiénes llevan +7 días sin marcar nada
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');

const ARCHIVO = '/root/agente-constructor/prospeccion-diaria/seguimiento.json';
const PROPIOS = /carlos\.salazar\.balam@gmail|balamcozu@proton|gnga\.web3@proton/i;

function leer() { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch { return {}; } }
function guardar(d) { fs.writeFileSync(ARCHIVO, JSON.stringify(d, null, 2)); }

async function historialResend() {
  const todos = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const r = await fetch('https://api.resend.com/emails?limit=100' + (after ? '&after=' + after : ''),
      { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } });
    const j = await r.json();
    if (!j.data || !j.data.length) break;
    todos.push(...j.data);
    if (j.data.length < 100) break;
    after = j.data[j.data.length - 1].id;
  }
  return todos;
}

async function sincronizar() {
  const registro = leer();
  const todos = await historialResend();
  let nuevos = 0;
  for (const e of todos) {
    const para = (e.to || [])[0];
    if (!para || PROPIOS.test(para)) continue;
    const correo = para.toLowerCase();
    if (!registro[correo]) {
      registro[correo] = {
        correo,
        asunto: e.subject || null,
        remitente: (e.from || '').match(/<(.+)>/)?.[1] || e.from || null,
        fecha_envio: e.created_at ? e.created_at.slice(0, 10) : null,
        estado_entrega: e.last_event || 'sent',
        estado_embudo: e.last_event === 'bounced' ? 'rebotado' : 'enviado',
        respondio_at: null,
        cita_at: null,
        cerrado_at: null,
        monto: null,
        nota: null,
        historial: [{ fecha: new Date().toISOString(), evento: 'sincronizado_de_resend' }],
      };
      nuevos++;
    }
  }
  guardar(registro);
  console.log(`Sincronizado. ${nuevos} prospectos nuevos importados. Total en seguimiento: ${Object.keys(registro).length}.`);
}

function marcar(correo, estado, opts = {}) {
  const registro = leer();
  const c = correo.toLowerCase();
  if (!registro[c]) {
    console.error(`"${correo}" no está en el seguimiento. Corre "sincronizar" primero, o revisa el correo.`);
    process.exit(1);
  }
  const validos = ['enviado', 'respondio', 'cita_agendada', 'cerrado_ganado', 'cerrado_perdido', 'sin_respuesta', 'rebotado'];
  if (!validos.includes(estado)) {
    console.error(`Estado inválido. Usa uno de: ${validos.join(', ')}`);
    process.exit(1);
  }
  registro[c].estado_embudo = estado;
  const ahora = new Date().toISOString();
  if (estado === 'respondio') registro[c].respondio_at = ahora;
  if (estado === 'cita_agendada') registro[c].cita_at = ahora;
  if (estado.startsWith('cerrado')) registro[c].cerrado_at = ahora;
  if (opts.monto) registro[c].monto = Number(opts.monto);
  if (opts.nota) registro[c].nota = opts.nota;
  registro[c].historial.push({ fecha: ahora, evento: `marcado_${estado}`, nota: opts.nota || null, monto: opts.monto || null });
  guardar(registro);
  console.log(`${correo} -> ${estado}${opts.monto ? ` ($${opts.monto} MXN)` : ''}`);
}

function estadisticas() {
  const registro = leer();
  const todos = Object.values(registro);
  const porEstado = {};
  let ingresoTotal = 0;
  for (const r of todos) {
    porEstado[r.estado_embudo] = (porEstado[r.estado_embudo] || 0) + 1;
    if (r.estado_embudo === 'cerrado_ganado' && r.monto) ingresoTotal += r.monto;
  }
  const enviados = todos.filter(r => r.estado_embudo !== 'rebotado').length;
  const respondieron = todos.filter(r => r.respondio_at).length;
  const citas = todos.filter(r => r.cita_at).length;
  const ganados = porEstado.cerrado_ganado || 0;
  const perdidos = porEstado.cerrado_perdido || 0;

  console.log(`\n📊 EMBUDO DE PROSPECCIÓN — Creativa Balam\n`);
  console.log(`Total contactados:     ${todos.length}`);
  console.log(`Rebotados:             ${porEstado.rebotado || 0}`);
  console.log(`Entregados:            ${enviados}`);
  console.log(`Respondieron:          ${respondieron}  (${enviados ? (100 * respondieron / enviados).toFixed(1) : 0}% de entregados)`);
  console.log(`Cita agendada:         ${citas}  (${respondieron ? (100 * citas / respondieron).toFixed(1) : 0}% de quienes respondieron)`);
  console.log(`Cerrado GANADO:        ${ganados}  (${citas ? (100 * ganados / citas).toFixed(1) : 0}% de las citas)`);
  console.log(`Cerrado perdido:       ${perdidos}`);
  console.log(`Sin respuesta aún:     ${porEstado.enviado || 0}`);
  console.log(`\nIngreso confirmado:    $${ingresoTotal.toLocaleString('es-MX')} MXN`);
  console.log(`\nTasa de cierre global (ganados / entregados): ${enviados ? (100 * ganados / enviados).toFixed(2) : 0}%`);

  const ganadosDetalle = todos.filter(r => r.estado_embudo === 'cerrado_ganado');
  if (ganadosDetalle.length) {
    console.log(`\n✅ Cerrados ganados:`);
    ganadosDetalle.forEach(r => console.log(`   - ${r.correo}: $${(r.monto || 0).toLocaleString('es-MX')} MXN — ${r.nota || 'sin nota'}`));
  }
}

function pendientes() {
  const registro = leer();
  const ahora = Date.now();
  const sinNovedad = Object.values(registro).filter(r => {
    if (r.estado_embudo !== 'enviado') return false;
    const dias = (ahora - new Date(r.fecha_envio).getTime()) / 86400000;
    return dias >= 7;
  });
  console.log(`${sinNovedad.length} prospectos con +7 días sin marcar novedad:`);
  sinNovedad.forEach(r => console.log(`   - ${r.correo} (enviado ${r.fecha_envio})`));
}

(async () => {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'sincronizar') await sincronizar();
  else if (cmd === 'marcar') {
    const [correo, estado] = args;
    const opts = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--monto') opts.monto = args[++i];
      if (args[i] === '--nota') opts.nota = args[++i];
    }
    marcar(correo, estado, opts);
  }
  else if (cmd === 'estadisticas') estadisticas();
  else if (cmd === 'pendientes') pendientes();
  else console.log('Uso: sincronizar | marcar <correo> <estado> [--monto N] [--nota "texto"] | estadisticas | pendientes');
})();
