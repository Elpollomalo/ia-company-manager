#!/usr/bin/env node
/**
 * PROSPECCIÓN DIARIA — PASO 4: ENVÍO (con o sin aprobación previa)
 *
 * Se llama de dos formas:
 *   node enviar-diario.js revisar          -> manda los borradores por Telegram (modo evaluación)
 *   node enviar-diario.js aprobar          -> Carlos dijo "manda": envía el lote
 *   node enviar-diario.js pasar            -> Carlos dijo "pasa": se descarta hoy
 *
 * En modo AUTO (después del período de evaluación) el orquestador llama
 * directo a la función enviar() sin pasar por Telegram.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { notificar, escaparHtml } = require('/root/agente-constructor/scripts/telegram-notify');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const HOY = new Date().toISOString().slice(0, 10);

// El dedup por DOMINIO existe por el caso Los Cinco Soles (un mismo negocio
// con varios buzones propios: wecare@ y hectorh@ no deben recibir dos correos).
// En un proveedor genérico eso no aplica: "mismo dominio" no significa "mismo
// negocio", y como ya se le escribió a otros prospectos en Gmail/Hotmail, todo
// candidato nuevo con ese tipo de correo tumbaba el lote completo. Ahí el
// dedup es sólo por correo exacto (4 septiembre 2026, antes de que pasara).
const GENERICOS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'hotmail.com.mx',
  'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'yahoo.com', 'yahoo.com.mx', 'yahoo.es',
  'icloud.com', 'me.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);
const DIR_HOY = path.join(BASE, HOY);
const CORREOS_JS = path.join(DIR_HOY, 'correos.js');

async function enviar() {
  if (!fs.existsSync(CORREOS_JS)) {
    await notificar(`⚠️ ${HOY}: no existe correos.js todavía. La redacción no ha terminado.`);
    return;
  }
  delete require.cache[require.resolve(CORREOS_JS)];
  const { CORREOS, DE, envolver } = require(CORREOS_JS);

  // ── Resumible: si una corrida previa de hoy ya mandó parte del lote (proceso
  // interrumpido, reintento), no la repitas ni actives el candado contra tu
  // propio envío -- eso es lo que forzó a improvisar enviar-pendientes.js el 2
  // de septiembre, saltándose plantilla, candado real y notificación. ──
  const LOG = path.join(DIR_HOY, 'enviados.log');
  const yaEnviadosHoy = new Set(
    (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '')
      .split('\n')
      .map(l => l.match(/^\S+\s+OK\s+(\S+)/)?.[1]?.toLowerCase())
      .filter(Boolean)
  );
  const pendientes = CORREOS.filter(c => !yaEnviadosHoy.has((c.para || '').toLowerCase()));
  if (!pendientes.length) {
    await notificar(`ℹ️ ${HOY}: los ${CORREOS.length} correos de hoy ya estaban enviados, nada pendiente.`);
    return;
  }

  // ── Candado 1: nadie repetido según Resend (por dominio, no solo correo exacto) ──
  const PROPIOS = /carlos\.salazar\.balam@gmail|balamcozu@proton|gnga\.web3@proton/i;
  const vistos = {};
  const dominiosVistos = new Set();
  let after = null;
  for (let i = 0; i < 10; i++) {
    const r = await fetch('https://api.resend.com/emails?limit=100' + (after ? '&after=' + after : ''),
      { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } });
    const j = await r.json();
    if (!j.data || !j.data.length) break;
    j.data.forEach(e => {
      const d = (e.to || [])[0];
      if (d && !PROPIOS.test(d)) {
        vistos[d.toLowerCase()] = e.created_at.slice(0, 10);
        const dom = d.toLowerCase().split('@')[1];
        if (dom) dominiosVistos.add(dom);
      }
    });
    if (j.data.length < 100) break;
    after = j.data[j.data.length - 1].id;
  }
  const choques = pendientes.filter(c => {
    const correo = (c.para || '').toLowerCase();
    const dom = correo.split('@')[1];
    return vistos[correo] || (dom && !GENERICOS.has(dom) && dominiosVistos.has(dom));
  });
  if (choques.length) {
    await notificar(`🛑 ${HOY}: ABORTADO, ya se les escribió antes: ${choques.map(c => escaparHtml(c.para)).join(', ')}`);
    return;
  }

  // ── Candado 2: el asunto tiene que nombrar al negocio ───────────────────
  // Bug del 8 de octubre: dos correos salieron con asunto genérico
  // ("No aparecen en Google cuando buscan buceo en Cozumel") y uno sin
  // asunto, porque el nombre del negocio venía mal parseado del informe.
  // Un correo de prospección sin el nombre del negocio se lee como spam,
  // así que aquí se bloquea y se reporta en vez de mandarlo.
  const { asuntoNombraNegocio } = require('./lib/nombres');
  const elegidosPorCorreo = {};
  try {
    for (const e of JSON.parse(fs.readFileSync(path.join(DIR_HOY, 'elegidos.json'), 'utf8'))) {
      if (e.correo) elegidosPorCorreo[e.correo.toLowerCase()] = e;
    }
  } catch {}

  const invalidos = [];
  for (const c of pendientes) {
    const eleg = elegidosPorCorreo[(c.para || '').toLowerCase()] || {};
    const veredicto = asuntoNombraNegocio(c.asunto, eleg.nombre);
    if (veredicto.ok) continue;
    invalidos.push({ c, motivo: veredicto.motivo });
  }

  if (invalidos.length) {
    for (const { c, motivo } of invalidos) {
      fs.appendFileSync(LOG, `${new Date().toISOString()}  RECHAZADO ${c.para}  ${motivo}\n`);
    }
    await notificar(
      `\u26d4 <b>${HOY}: ${invalidos.length} correo(s) NO se enviaron</b> \u2014 el asunto no nombra al negocio.\n` +
      invalidos.map(({ c, motivo }) => `\u2022 <code>${escaparHtml(c.para)}</code>: ${escaparHtml(motivo)}`).join('\n') +
      `\n\nLos dem\u00e1s del lote s\u00ed se mandan.`,
      { html: true });
  }

  const aEnviar = pendientes.filter(c => !invalidos.some(i => i.c === c));
  if (!aEnviar.length) return;

  // ── Envío con espaciado de 90 s ─────────────────────────────────────────
  // Registrar en panel.db al enviar
  let panelDb;
  try { panelDb = require('/root/ponexo-root/node_modules/better-sqlite3')('/root/ponexo-root/panel.db'); } catch {}
  const registrarEnvio = panelDb ? panelDb.prepare(`
    INSERT OR IGNORE INTO prospectos (proyecto, nombre, zona, dominio, url, correo, tipo_campana,
      dato_duro, rendimiento, lcp, estado, enviado_at, resend_id, giro, asunto, cuerpo_preview, cuerpo_html, creado_at, actualizado_at)
    VALUES ('creativa-balam', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enviado', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `) : null;
  const actualizarEnvio = panelDb ? panelDb.prepare(`
    UPDATE prospectos SET estado='enviado', enviado_at=?, resend_id=?, asunto=?, cuerpo_preview=?, cuerpo_html=?,
      actualizado_at=datetime('now') WHERE correo=?
  `) : null;

  // Leer elegidos.json para metadata
  let elegidosData = [];
  try { elegidosData = JSON.parse(fs.readFileSync(path.join(DIR_HOY, 'elegidos.json'), 'utf8')); } catch {}

  const apunte = t => fs.appendFileSync(LOG, `${new Date().toISOString()}  ${t}\n`);
  for (const c of aEnviar) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: DE, to: c.para, subject: c.asunto, html: envolver(c.cuerpo) }),
      });
      const j = await r.json();
      apunte(r.ok ? `OK    ${c.para}  id=${j.id}` : `FALLO ${c.para}  ${JSON.stringify(j)}`);
      // Registrar en panel.db
      if (r.ok && registrarEnvio) {
        const eleg = elegidosData.find(e => (e.correo || '').toLowerCase() === (c.para || '').toLowerCase()) || {};
        const dom = (c.para || '').split('@')[1] || '';
        const preview = (c.cuerpo || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
        const html = envolver(c.cuerpo || '');
        const ts = new Date().toISOString();
        try {
          const res = registrarEnvio.run(eleg.nombre || dom, eleg.zona || 'desconocida', eleg.dominio || dom,
            eleg.url || null, c.para, eleg.tipo_campana || 'sitio_lento',
            eleg.dato_duro || null, eleg.rend || null, eleg.lcp || null,
            ts, j.id, eleg.giro || null, c.asunto, preview, html);
          if (res.changes === 0 && actualizarEnvio) {
            actualizarEnvio.run(ts, j.id, c.asunto, preview, html, c.para);
          }
        } catch {}
      }
    } catch (e) {
      apunte(`ERROR ${c.para}  ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 90000));
  }
  if (panelDb) try { panelDb.close(); } catch {}

  const ok = (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').match(/OK /g) || [] : []).length;
  await notificar(`✅ <b>Prospección diaria ${HOY} enviada</b>: ${ok}/${CORREOS.length} correos.\nLog: <code>${LOG}</code>`, { html: true });
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'revisar') {
    // Manda los borradores completos a Telegram para lectura
    if (!fs.existsSync(CORREOS_JS)) { await notificar(`⏳ ${HOY}: la redacción sigue en curso, no hay borradores aún.`); return; }
    delete require.cache[require.resolve(CORREOS_JS)];
    const { CORREOS } = require(CORREOS_JS);
    let texto = `📨 <b>Borradores ${HOY}</b>\n\n`;
    for (const c of CORREOS) {
      const plano = c.cuerpo.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      texto += `<b>[${escaparHtml(c.para)}]</b>\n<i>${escaparHtml(c.asunto)}</i>\n${escaparHtml(plano.slice(0, 600))}...\n\n`;
    }
    texto += `Responde <b>manda</b> o <b>pasa</b>.`;
    await notificar(texto.slice(0, 4000), { html: true });
  } else if (cmd === 'aprobar') {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'APROBADO');
    await enviar();
  } else if (cmd === 'pasar') {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'DESCARTADO');
    await notificar(`↩️ ${HOY}: borradores descartados por Carlos.`);
  } else if (cmd === 'auto') {
    await enviar();
  }
})();
