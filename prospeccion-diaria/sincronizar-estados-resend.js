#!/usr/bin/env node
/**
 * CONTROL DE ENTREGAS Y REBOTES — Creativa Balam
 *
 * Por qué existe (3 noviembre 2026):
 * El panel guardaba `estado='enviado'` en el instante en que Resend aceptaba
 * el correo, y nadie volvía a mirar. `info@spanishschools.com.mx` rebotó a los
 * pocos segundos (550 5.1.1, buzón inexistente) y en el panel seguía —y sigue—
 * contando como contactado. Eso es un falso positivo: Carlos cree que le
 * escribió a alguien que nunca recibió nada, y el embudo miente.
 *
 * Resend es la única fuente de verdad sobre lo que pasó después del envío:
 * expone `last_event` por correo (sent / delivered / bounced / complained).
 * Este script lo jala y corrige las tres copias del estado:
 *
 *   1. panel.db  -> prospectos.resend_status + estado (enviado -> rebotado)
 *   2. seguimiento.json -> estado_entrega / estado_embudo
 *   3. rebotes.json -> registro permanente: a quién, cuándo, por qué (motivo
 *      SMTP real, verificado con lib/verificar-buzon.js)
 *
 * No manda correo a nadie. Se puede correr cuantas veces se quiera: es
 * idempotente.
 *
 * Uso:
 *   node sincronizar-estados-resend.js            -> corrige y reporta
 *   node sincronizar-estados-resend.js --alert    -> además avisa a Telegram si
 *                                                    hay un rebote nuevo
 *   node sincronizar-estados-resend.js --dry-run  -> dice qué cambiaría, sin tocar nada
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const REBOTES_PATH = path.join(BASE, 'rebotes.json');
const PANEL_DB = '/root/ponexo-root/panel.db';
const PROPIOS = /carlos\.salazar\.balam@gmail|balamcozu@proton|gnga\.web3@proton/i;

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const ALERT = ARGS.includes('--alert');

async function historialResend() {
  const todos = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const r = await fetch('https://api.resend.com/emails?limit=100' + (after ? '&after=' + after : ''),
      { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } });
    const j = await r.json();
    if (!Array.isArray(j.data) || !j.data.length) break;
    todos.push(...j.data);
    if (j.data.length < 100) break;
    after = j.data[j.data.length - 1].id;
  }
  return todos.filter(e => {
    const para = (e.to || [])[0];
    return para && !PROPIOS.test(para);
  });
}

function leerRebotes() {
  try { return JSON.parse(fs.readFileSync(REBOTES_PATH, 'utf8')); } catch { return { actualizado: null, rebotes: {} }; }
}

/** Corrige panel.db. Devuelve la lista de cambios. */
function corregirPanel(porId) {
  const cambios = [];
  let db;
  try { db = require('/root/ponexo-root/node_modules/better-sqlite3')(PANEL_DB); }
  catch (e) { return { cambios, error: 'sin acceso a panel.db: ' + e.message }; }

  const filas = db.prepare(`SELECT id, correo, estado, resend_id, resend_status FROM prospectos WHERE resend_id IS NOT NULL`).all();

  // Reconciliación local: hay prospectos cuyo resend_status ya decía 'bounced'
  // de una revisión anterior pero seguían con estado='enviado' (el envío nunca
  // miró ese campo). Resend sólo guarda los últimos ~40 correos, así que esos
  // casos ya no aparecen en el historial remoto: se corrigen aquí, con lo que
  // ya sabemos.
  const locales = db.prepare(`SELECT id, correo, estado, resend_status, motivo_descarte FROM prospectos
                              WHERE estado = 'enviado' AND resend_status IN ('bounced','suppressed')`).all();
  const localUpd = db.prepare(`UPDATE prospectos SET estado='rebotado', motivo_descarte=?, actualizado_at=datetime('now') WHERE id=?`);
  for (const f of locales) {
    cambios.push({ id: f.id, correo: f.correo, antes: `${f.estado}/${f.resend_status}`, despues: `rebotado/${f.resend_status}` });
    if (!DRY) localUpd.run(f.resend_status === 'suppressed' ? 'suprimido_resend' : 'rebote_buzon', f.id);
  }
  const upd = db.prepare(`UPDATE prospectos SET resend_status=?, estado=?, actualizado_at=datetime('now') WHERE id=?`);
  const soloEstadoResend = db.prepare(`UPDATE prospectos SET resend_status=?, actualizado_at=datetime('now') WHERE id=?`);

  // Cierre del círculo: si el registro de rebotes ya conoce una caída, el panel
  // no puede seguir diciendo 'enviado'. Cubre los casos fuera de la ventana de
  // Resend (p. ej. el dominio que ya ni resuelve).
  const reg = leerRebotes();
  for (const r of Object.values(reg.rebotes || {})) {
    const fila = db.prepare(`SELECT id, correo, estado FROM prospectos WHERE lower(correo)=?`).get(r.correo);
    if (!fila || fila.estado !== 'enviado') continue;
    cambios.push({ id: fila.id, correo: fila.correo, antes: `enviado/-`, despues: `rebotado/registro` });
    if (!DRY) upd.run(r.diagnostico === 'suprimido' ? 'suppressed' : 'bounced', 'rebotado', fila.id);
  }

  for (const f of filas) {
    const ev = porId[f.resend_id];
    if (!ev) continue;
    const evento = ev.last_event || 'sent';
    const pasaARebotado = evento === 'bounced' && f.estado === 'enviado';
    if (f.resend_status === evento && !pasaARebotado) continue;
    cambios.push({ id: f.id, correo: f.correo, antes: `${f.estado}/${f.resend_status || '-'}`, despues: `${pasaARebotado ? 'rebotado' : f.estado}/${evento}` });
    if (DRY) continue;
    if (pasaARebotado) upd.run(evento, 'rebotado', f.id);
    else soloEstadoResend.run(evento, f.id);
  }
  try { db.close(); } catch {}
  return { cambios };
}

/** Guarda en rebotes.json los rebotes que aún no estaban registrados. */
async function registrarRebotes(emails) {
  const reg = leerRebotes();
  reg.rebotes = reg.rebotes || {};
  const nuevos = [];
  const { verificarBuzon } = require('./lib/verificar-buzon');

  for (const e of emails) {
    const evento = e.last_event || '';
    if (evento !== 'bounced' && evento !== 'suppressed') continue;
    const correo = ((e.to || [])[0] || '').toLowerCase();
    if (!correo || reg.rebotes[correo]) continue;

    // Motivo real del rechazo: se vuelve a preguntar al MX del destinatario.
    let motivo = 'Resend lo suprimió antes de enviarlo (dirección en su lista de bloqueo)';
    let estado = 'suprimido';
    if (evento === 'bounced') {
      try {
        const v = await verificarBuzon(correo, { forzar: !DRY });
        motivo = v.motivo;
        estado = v.estado;
      } catch (err) { motivo = 'no se pudo verificar: ' + err.message; estado = 'desconocido'; }
    }

    const dominio = correo.split('@')[1] || '';
    const registro = {
      correo,
      dominio,
      fecha_envio: e.created_at || null,
      resend_id: e.id,
      asunto: e.subject || null,
      motivo,
      diagnostico: estado,        // inexistente | temporal | desconocido | valido
      permanente: estado === 'inexistente' || estado === 'suprimido' || /ENOTFOUND/i.test(motivo),
    };
    nuevos.push(registro);
    if (!DRY) reg.rebotes[correo] = registro;
  }

  if (!DRY) {
    reg.actualizado = new Date().toISOString();
    fs.writeFileSync(REBOTES_PATH, JSON.stringify(reg, null, 2));
  }
  return nuevos;
}

function resumenRebotes() {
  const reg = leerRebotes();
  const todos = Object.values(reg.rebotes || {});
  const porDominio = {};
  todos.forEach(r => { porDominio[r.dominio] = (porDominio[r.dominio] || 0) + 1; });
  return { total: todos.length, porDominio, permanentes: todos.filter(r => r.permanente).length };
}

/**
 * Rellena el registro con los rebotes que ya conocemos por el panel pero que no
 * están en rebotes.json: son los anteriores a la ventana de Resend (~40 correos),
 * así que ya no hay forma de pedirles el motivo. Se anotan como tales en vez de
 * dejarlos fuera del conteo, o la tasa saldría más bonita de lo que es.
 */
function rellenarDesdePanel() {
  const reg = leerRebotes();
  reg.rebotes = reg.rebotes || {};
  let agregados = 0;
  try {
    const db = require('/root/ponexo-root/node_modules/better-sqlite3')(PANEL_DB, { readonly: true });
    const filas = db.prepare(`SELECT correo, resend_status, enviado_at, asunto FROM prospectos
                              WHERE estado='rebotado' AND correo IS NOT NULL`).all();
    for (const f of filas) {
      const correo = f.correo.toLowerCase();
      if (reg.rebotes[correo]) continue;
      reg.rebotes[correo] = {
        correo,
        dominio: correo.split('@')[1] || '',
        fecha_envio: f.enviado_at || null,
        resend_id: null,
        asunto: f.asunto || null,
        motivo: 'rebote anterior a la ventana de Resend (sin detalle del proveedor)',
        diagnostico: f.resend_status === 'suppressed' ? 'suprimido' : 'desconocido',
        permanente: true,
        origen: 'panel',
      };
      agregados++;
    }
    db.close();
  } catch (e) { return { agregados: 0, error: e.message }; }
  if (agregados && !DRY) {
    reg.actualizado = new Date().toISOString();
    fs.writeFileSync(REBOTES_PATH, JSON.stringify(reg, null, 2));
  }
  return { agregados };
}

/**
 * Lista de supresión de Resend: es acumulativa y permanente (no caduca como el
 * historial de correos). Aquí están TODOS los buzones que rebotaron o se quejaron
 * desde que abrimos la cuenta. Es la fuente de verdad del "desde que empezamos".
 */
async function listaSuprimidos() {
  const salida = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const url = new URL('https://api.resend.com/suppressions');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (!r.ok) throw new Error(`suppressions ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    salida.push(...(j.data || []));
    if (!j.has_more || !(j.data || []).length) break;
    after = j.data[j.data.length - 1].id;
  }
  return salida;
}

function fusionarSuprimidos(suprimidos) {
  const reg = leerRebotes();
  reg.rebotes = reg.rebotes || {};
  let nuevos = 0;
  for (const s of suprimidos) {
    const correo = (s.email || '').toLowerCase();
    if (!correo) continue;
    const previo = reg.rebotes[correo];
    if (previo && previo.motivo && !/ventana de Resend/.test(previo.motivo)) continue;
    reg.rebotes[correo] = {
      correo,
      dominio: correo.split('@')[1] || '',
      fecha_envio: s.created_at || (previo && previo.fecha_envio) || null,
      resend_id: s.source_id || null,
      asunto: (previo && previo.asunto) || null,
      motivo: (previo && previo.motivo) || `rebote confirmado por Resend (${s.origin})`,
      diagnostico: s.origin === 'complaint' ? 'queja' : 'rebote',
      permanente: true,
      origen: 'suppressions',
    };
    nuevos++;
  }
  if (nuevos && !DRY) {
    reg.actualizado = new Date().toISOString();
    fs.writeFileSync(REBOTES_PATH, JSON.stringify(reg, null, 2));
  }
  return nuevos;
}

(async () => {
  if (!process.env.RESEND_API_KEY) {
    console.error('Falta RESEND_API_KEY en el entorno.');
    process.exit(1);
  }

  const emails = await historialResend();
  const porId = {};
  emails.forEach(e => { porId[e.id] = e; });

  // 1. panel.db
  const { cambios, error } = corregirPanel(porId);
  if (error) console.error('⚠️  ' + error);

  // 2. seguimiento.json (tiene su propia lógica de corrección)
  let seguimiento = { nuevos: 0, corregidos: [] };
  if (!DRY) {
    try { seguimiento = await require('./seguimiento').sincronizar(); }
    catch (e) { console.error('⚠️  seguimiento.json: ' + e.message); }
  }

  // 3. rebotes.json
  const nuevosRebotes = await registrarRebotes(emails);
  let nuevosSuprimidos = 0;
  try {
    nuevosSuprimidos = fusionarSuprimidos(await listaSuprimidos());
  } catch (e) {
    console.error('⚠️ No se pudo leer la lista de supresión de Resend: ' + e.message);
  }
  const relleno = rellenarDesdePanel();
  const resumen = resumenRebotes();

  const entregados = emails.filter(e => e.last_event === 'delivered').length;
  const rebotados = emails.filter(e => e.last_event === 'bounced').length;
  const tasa = emails.length ? (100 * rebotados / emails.length) : 0;

  const lineas = [
    `📬 Entregas revisadas: ${emails.length} correos`,
    `   entregados ${entregados} · rebotados ${rebotados} (${tasa.toFixed(1)}%)`,
    cambios.length ? `\n✏️  panel.db: ${cambios.length} corregidos` : '\n✏️  panel.db: nada que corregir',
    ...cambios.slice(0, 10).map(c => `   • ${c.correo}: ${c.antes} → ${c.despues}`),
    seguimiento.nuevos ? `\n📒 seguimiento.json: ${seguimiento.nuevos} nuevos` : '',
    seguimiento.corregidos?.length ? `📒 corregidos a rebotado: ${seguimiento.corregidos.join(', ')}` : '',
    nuevosRebotes.length ? `\n🔴 Rebotes nuevos: ${nuevosRebotes.length}` : '',
    ...nuevosRebotes.map(r => `   • ${r.correo} — ${r.diagnostico}: ${r.motivo.slice(0, 110)}`),
    `\n📊 Registro histórico: ${resumen.total} rebotes (${resumen.permanentes} permanentes)`,
  ].filter(Boolean);
  console.log(lineas.join('\n'));

  if (DRY) console.log('\n(dry-run: no se escribió nada)');

  if (ALERT && !DRY && (nuevosRebotes.length || cambios.length || seguimiento.corregidos?.length)) {
    const { notificar, escaparHtml } = require('/root/agente-constructor/scripts/telegram-notify');
    await notificar(
      `🔴 <b>Rebote detectado</b>\n` +
      nuevosRebotes.map(r => `• <code>${escaparHtml(r.correo)}</code>\n   ${escaparHtml(r.diagnostico)}: ${escaparHtml(r.motivo.slice(0, 140))}`).join('\n') +
      `\n\nCorregido en panel y seguimiento. Ese dominio queda fuera de las próximas listas.`,
      { html: true });
  }
})();
