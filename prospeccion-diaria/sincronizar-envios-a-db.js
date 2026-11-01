#!/usr/bin/env node
/**
 * Sincroniza envíos de correos (enviados.log + elegidos.json + correos.js)
 * a la tabla prospectos de panel.db. Idempotente.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const db = new Database('/root/ponexo-root/panel.db');

const insert = db.prepare(`
  INSERT OR IGNORE INTO prospectos (proyecto, nombre, zona, dominio, url, correo, tipo_campana, dato_duro,
    rendimiento, lcp, estado, enviado_at, resend_id, giro, asunto, cuerpo_preview, creado_at, actualizado_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enviado', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const update = db.prepare(`
  UPDATE prospectos SET estado='enviado', enviado_at=?, resend_id=?, asunto=?, cuerpo_preview=?,
    actualizado_at=datetime('now') WHERE correo=?
`);

// List all date folders
const carpetas = fs.readdirSync(BASE)
  .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .sort();

let total = 0;
for (const fecha of carpetas) {
  const dir = path.join(BASE, fecha);
  const logPath = path.join(dir, 'enviados.log');
  const elegidosPath = path.join(dir, 'elegidos.json');
  const correosPath = path.join(dir, 'correos.js');

  if (!fs.existsSync(logPath)) continue;

  // Parse enviados.log
  const envios = fs.readFileSync(logPath, 'utf8').split('\n')
    .map(l => l.match(/^(\S+)\s+OK\s+(\S+)\s+id=(\S+)/))
    .filter(Boolean)
    .map(m => ({ timestamp: m[1], correo: m[2], resendId: m[3] }));

  if (!envios.length) continue;

  // Load elegidos for metadata
  let elegidos = [];
  try { elegidos = JSON.parse(fs.readFileSync(elegidosPath, 'utf8')); } catch {}

  // Load correos.js for asunto/cuerpo
  let correos = [];
  try {
    delete require.cache[require.resolve(correosPath)];
    const mod = require(correosPath);
    correos = mod.CORREOS || [];
  } catch {}

  for (const env of envios) {
    const eleg = elegidos.find(e => (e.correo || '').toLowerCase() === env.correo.toLowerCase()) || {};
    const correoObj = correos.find(c => (c.para || '').toLowerCase() === env.correo.toLowerCase()) || {};
    
    const dom = env.correo.split('@')[1] || '';
    const cuerpoPlano = (correoObj.cuerpo || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    try {
      // Try insert first, if exists update
      const res = insert.run(
        'creativa-balam',
        eleg.nombre || dom,
        eleg.zona || 'desconocida',
        eleg.dominio || dom,
        eleg.url || null,
        env.correo,
        eleg.tipo_campana || 'sitio_lento',
        eleg.dato_duro || (eleg.rend ? `${eleg.rend}/100 rendimiento, LCP ${eleg.lcp}s` : null),
        eleg.rend || null,
        eleg.lcp || null,
        env.timestamp,
        env.resendId,
        eleg.giro || null,
        correoObj.asunto || null,
        cuerpoPlano ? cuerpoPlano.slice(0, 500) : null
      );
      if (res.changes === 0) {
        // Already exists, update it
        update.run(env.timestamp, env.resendId, correoObj.asunto || null,
          cuerpoPlano ? cuerpoPlano.slice(0, 500) : null, env.correo);
      }
      total++;
    } catch (e) {
      // Skip duplicates silently
    }
  }
}

db.close();
console.log(`Sincronizados: ${total} envíos a panel.db`);
