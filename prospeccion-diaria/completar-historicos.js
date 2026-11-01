#!/usr/bin/env node
/**
 * Completa lo que falta en los prospectos históricos:
 *
 *  1. asunto  — desde seguimiento.json (el embudo viejo sí lo guardaba) y,
 *               si no está ahí, desde correos.js del día del envío.
 *  2. nombre  — para los envíos de agosto/septiembre cuyo nombre de negocio
 *               NUNCA se guardó en ningún lado, se usa el dominio como
 *               etiqueta honesta ("saltyendeavors.com") en vez de inventar
 *               un nombre bonito a partir del slug.
 *
 * No toca filas que ya tienen un nombre válido ni un asunto ya puesto.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');
const { esNombreValido } = require('./lib/nombres');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const SEGUIMIENTO = path.join(BASE, 'seguimiento.json');
const db = new Database('/root/ponexo-root/panel.db');

const GENERICOS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'hotmail.com.mx',
  'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'yahoo.com', 'yahoo.com.mx', 'yahoo.es',
  'icloud.com', 'me.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'usa.net']);

// ── asunto por correo: seguimiento.json + correos.js de cada día ───────────
const asuntoPorCorreo = {};

if (fs.existsSync(SEGUIMIENTO)) {
  try {
    const seg = JSON.parse(fs.readFileSync(SEGUIMIENTO, 'utf8'));
    for (const [correo, datos] of Object.entries(seg)) {
      if (datos && datos.asunto) asuntoPorCorreo[correo.toLowerCase()] = datos.asunto;
    }
  } catch (e) {
    console.warn('No se pudo leer seguimiento.json:', e.message);
  }
}

for (const carpeta of fs.readdirSync(BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
  const p = path.join(BASE, carpeta, 'correos.js');
  if (!fs.existsSync(p)) continue;
  try {
    delete require.cache[require.resolve(p)];
    const mod = require(p);
    for (const c of mod.CORREOS || []) {
      if (c.para && c.asunto && !asuntoPorCorreo[c.para.toLowerCase()]) {
        asuntoPorCorreo[c.para.toLowerCase()] = c.asunto;
      }
    }
  } catch {}
}

// ── Reparar ────────────────────────────────────────────────────────────────
const filas = db.prepare('SELECT id, nombre, correo, dominio, asunto FROM prospectos').all();
const setAsunto = db.prepare('UPDATE prospectos SET asunto=?, actualizado_at=datetime(\'now\') WHERE id=?');
const setNombre = db.prepare('UPDATE prospectos SET nombre=?, actualizado_at=datetime(\'now\') WHERE id=?');

let asuntos = 0;
let nombres = 0;

for (const f of filas) {
  const correo = (f.correo || '').toLowerCase();

  if ((!f.asunto || !f.asunto.trim()) && asuntoPorCorreo[correo]) {
    setAsunto.run(asuntoPorCorreo[correo], f.id);
    asuntos++;
  }

  if (!esNombreValido(f.nombre)) {
    const dom = f.dominio || '';
    const esGenerico = !dom || GENERICOS.has(dom);
    const etiqueta = esGenerico ? (f.correo || dom || 'sin identificar') : dom;
    if (etiqueta && etiqueta !== f.nombre) {
      setNombre.run(etiqueta, f.id);
      nombres++;
    }
  }
}

db.close();
console.log(`Asuntos completados: ${asuntos}`);
console.log(`Nombres etiquetados con dominio/correo: ${nombres}`);
