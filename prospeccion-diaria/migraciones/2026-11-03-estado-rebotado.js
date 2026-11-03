#!/usr/bin/env node
/**
 * Migración 3 nov 2026: agregar 'rebotado' al CHECK de prospectos.estado.
 *
 * Por qué: el estado del panel sólo admitía pool/descartado/enviado/respondio/
 * cita_agendada y los cerrados. Un correo que Resend reporta como
 * rebotado no tenía dónde caer, así que se quedaba como 'enviado' — el falso
 * positivo que Carlos detectó. SQLite no permite cambiar un CHECK en sitio: hay
 * que reconstruir la tabla. Se copia todo, se recrean los índices y se compara
 * el conteo antes/después. Si algo no cuadra, no se hace COMMIT.
 */
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');
const DB = '/root/ponexo-root/panel.db';

const db = new Database(DB);
const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='prospectos'").get().sql;

if (original.includes("'rebotado'")) {
  console.log('Ya migrado: el CHECK ya admite rebotado. Nada que hacer.');
  process.exit(0);
}

const indices = db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name='prospectos' AND type='index' AND sql IS NOT NULL").all();
const columnas = db.prepare('PRAGMA table_info(prospectos)').all().map(c => c.name);
const antes = db.prepare('SELECT COUNT(*) n FROM prospectos').get().n;

const nuevaSql = original
  .replace('CREATE TABLE prospectos', 'CREATE TABLE prospectos_nuevo')
  .replace("'sin_respuesta'\n  )", "'sin_respuesta', 'rebotado'\n  )");

if (!nuevaSql.includes("'rebotado'")) {
  console.error('No se pudo inyectar rebotado en el CHECK. Abortado sin tocar nada.');
  console.error(nuevaSql.slice(0, 600));
  process.exit(1);
}

const cols = columnas.join(', ');
db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  db.exec(nuevaSql);
  db.exec(`INSERT INTO prospectos_nuevo (${cols}) SELECT ${cols} FROM prospectos`);
  db.exec('DROP TABLE prospectos');
  db.exec('ALTER TABLE prospectos_nuevo RENAME TO prospectos');
  for (const i of indices) {
    // El índice único de correo lleva WHERE; se recrea tal cual.
    db.exec(i.sql.replace(`ON prospectos(`, `ON prospectos(`));
  }
  const despues = db.prepare('SELECT COUNT(*) n FROM prospectos').get().n;
  if (antes !== despues) throw new Error(`conteo no cuadra: antes ${antes}, después ${despues}`);
  db.exec('COMMIT');
  console.log(`Migración OK: ${despues} prospectos conservados, ${indices.length} índices recreados, CHECK admite 'rebotado'.`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('ROLLBACK: ' + e.message);
  process.exitCode = 1;
}
db.close();
