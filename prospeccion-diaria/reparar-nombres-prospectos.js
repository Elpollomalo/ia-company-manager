#!/usr/bin/env node
/**
 * Repara nombres de prospectos que quedaron con el ASUNTO del correo (o una
 * nota de tabla) en vez del nombre del negocio.
 *
 * Fuentes, en orden de confianza:
 *   1. elegidos.json de cada día del pipeline (correo -> nombre)
 *   2. los informes del vault (dominio -> nombre)   <- la mejor para históricos
 *   3. nada: si no hay con qué, se deja como está y se reporta
 *
 * Nunca inventa un nombre a partir del slug del dominio: eso produjo
 * "Gmail" y "Hotmail" como nombres de negocio en la primera pasada.
 *
 * Solo toca filas cuyo nombre no pasa esNombreValido(), así que es seguro
 * volver a correrlo.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');
const { esNombreValido, negociosDeTablas } = require('./lib/nombres');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const VAULTS = [
  '/root/agente-constructor/vault/7-investigacion-mercado/creativa-balam',
  '/root/agente-constructor/vault/7-prospeccion-negocios',
];
const db = new Database('/root/ponexo-root/panel.db');

// ── 1. correo -> nombre desde elegidos.json ────────────────────────────────
const porCorreo = {};
for (const carpeta of fs.readdirSync(BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
  const p = path.join(BASE, carpeta, 'elegidos.json');
  if (!fs.existsSync(p)) continue;
  let lista;
  try { lista = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  for (const e of lista) {
    if (!e.correo || !esNombreValido(e.nombre)) continue;
    porCorreo[e.correo.toLowerCase()] = e.nombre;
  }
}

// ── 2. dominio -> nombre desde los informes del vault ──────────────────────
function recorrer(dir) {
  const salida = [];
  if (!fs.existsSync(dir)) return salida;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) salida.push(...recorrer(p));
    else if (e.name.endsWith('.md')) salida.push(p);
  }
  return salida;
}

const porDominio = {};
for (const vault of VAULTS) {
  for (const archivo of recorrer(vault)) {
    let texto;
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch { continue; }
    for (const n of negociosDeTablas(texto)) {
      if (!n.dominio || !esNombreValido(n.nombre)) continue;
      if (!porDominio[n.dominio]) porDominio[n.dominio] = n.nombre;
    }
  }
}

// ── Reparar ────────────────────────────────────────────────────────────────
// Además de los nombres inválidos, se reprocesan los que la primera pasada
// derivó del slug del dominio y quedaron como "Gmail", "Hotmail" o "Hotelbcozumel".
const BASURA_DE_DOMINIO = /^(gmail|hotmail|yahoo|outlook|live|icloud|proton|usa|prueba|creativabalam|prodigy)$/i;

function necesitaReparo(fila) {
  if (!esNombreValido(fila.nombre)) return true;
  if (BASURA_DE_DOMINIO.test(fila.nombre.trim())) return true;
  // Una sola palabra sin espacios que coincide con el slug del dominio
  const slug = (fila.dominio || '').split('.').slice(0, -1).join('').replace(/[-_]/g, '').toLowerCase();
  const nombreSlug = (fila.nombre || '').replace(/[\s-_]/g, '').toLowerCase();
  if (slug && nombreSlug === slug && !/\s/.test(fila.nombre.trim())) return true;
  return false;
}

const filas = db.prepare('SELECT id, nombre, correo, dominio FROM prospectos').all();
const actualizar = db.prepare('UPDATE prospectos SET nombre=?, actualizado_at=datetime(\'now\') WHERE id=?');

let reparados = 0;
const sinArreglo = [];

for (const f of filas) {
  if (!necesitaReparo(f)) continue;

  let nuevo = f.correo ? porCorreo[f.correo.toLowerCase()] : null;
  let origen = 'elegidos.json';
  if (!nuevo && f.dominio) {
    nuevo = porDominio[f.dominio] || null;
    origen = 'informe del vault';
  }

  if (!nuevo || nuevo === f.nombre) {
    sinArreglo.push(f);
    continue;
  }

  actualizar.run(nuevo, f.id);
  reparados++;
  console.log(`id=${f.id} [${origen}] "${f.nombre.slice(0, 45)}" -> "${nuevo}"`);
}

db.close();
console.log(`\nReparados: ${reparados}`);
if (sinArreglo.length) {
  console.log(`Sin arreglo: ${sinArreglo.length}`);
  for (const s of sinArreglo) console.log(`  id=${s.id} "${s.nombre}" <${s.correo}>`);
}
