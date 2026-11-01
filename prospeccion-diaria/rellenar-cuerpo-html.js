#!/usr/bin/env node
/**
 * Rellena prospectos.cuerpo_html con el HTML EXACTO que recibió el cliente
 * (plantilla de marca incluida), reconstruido desde correos.js de cada día.
 *
 * El correo se mandó como envolver(c.cuerpo), y envolver vive en el mismo
 * correos.js, así que reconstruirlo da el mismo HTML que salió por Resend.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const db = new Database('/root/ponexo-root/panel.db');

const actualizar = db.prepare(
  `UPDATE prospectos SET cuerpo_html = ? WHERE correo = ? AND (cuerpo_html IS NULL OR cuerpo_html = '')`
);

let actualizados = 0;
const carpetas = fs.readdirSync(BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

for (const fecha of carpetas) {
  const correosPath = path.join(BASE, fecha, 'correos.js');
  if (!fs.existsSync(correosPath)) continue;

  let mod;
  try {
    delete require.cache[require.resolve(correosPath)];
    mod = require(correosPath);
  } catch (e) {
    console.warn(`${fecha}: no se pudo cargar correos.js (${e.message})`);
    continue;
  }
  if (!Array.isArray(mod.CORREOS) || typeof mod.envolver !== 'function') continue;

  for (const c of mod.CORREOS) {
    try {
      const html = mod.envolver(c.cuerpo || '');
      const res = actualizar.run(html, c.para);
      actualizados += res.changes;
    } catch (e) {
      console.warn(`${fecha}: ${c.para} falló (${e.message})`);
    }
  }
}

db.close();
console.log(`cuerpo_html actualizado en ${actualizados} prospectos.`);
