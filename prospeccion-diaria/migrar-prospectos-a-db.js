#!/usr/bin/env node
/**
 * migrar-prospectos-a-db.js
 * 
 * Migra datos de seguimiento.json, pool-verificado.json y descartados-permanentes.json
 * a la tabla `prospectos` en panel.db.
 * 
 * - No borra los archivos JSON originales.
 * - Usa INSERT OR IGNORE para no duplicar si se corre más de una vez.
 * - Todos los registros migrados se marcan como tipo_campana='sitio_lento' (ángulo original).
 */

const path = require('path');
const fs = require('fs');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');

const DB_PATH = '/root/ponexo-root/panel.db';
const BASE = '/root/agente-constructor/prospeccion-diaria';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Helpers ──────────────────────────────────────────────────
function loadJSON(file) {
  const full = path.join(BASE, file);
  if (!fs.existsSync(full)) {
    console.warn(`⚠ ${file} no existe, se omite.`);
    return null;
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function dominioFromCorreo(correo) {
  if (!correo) return null;
  const parts = correo.split('@');
  return parts.length === 2 ? parts[1] : null;
}

function mapEstadoEmbudo(estadoEmbudo, estadoEntrega) {
  // seguimiento.json tiene estado_embudo: enviado, rebotado, respondio, cita_agendada, cerrado_ganado, cerrado_perdido, sin_respuesta
  const map = {
    'enviado': 'enviado',
    'rebotado': 'enviado',           // bounced but was sent
    'respondio': 'respondio',
    'cita_agendada': 'cita_agendada',
    'cerrado_ganado': 'cerrado_ganado',
    'cerrado_perdido': 'cerrado_perdido',
    'sin_respuesta': 'sin_respuesta',
  };
  return map[estadoEmbudo] || 'enviado';
}

// ── Prepared statements ──────────────────────────────────────
const insertProspecto = db.prepare(`
  INSERT OR IGNORE INTO prospectos (
    proyecto, nombre, zona, dominio, url, correo,
    tipo_campana, dato_duro, contexto_extra,
    rendimiento, lcp, estado, motivo_descarte,
    agregado_al_pool_at, enviado_at, respondio_at, cita_at, cerrado_at,
    monto, nota, resend_id, resend_status, giro
  ) VALUES (
    @proyecto, @nombre, @zona, @dominio, @url, @correo,
    @tipo_campana, @dato_duro, @contexto_extra,
    @rendimiento, @lcp, @estado, @motivo_descarte,
    @agregado_al_pool_at, @enviado_at, @respondio_at, @cita_at, @cerrado_at,
    @monto, @nota, @resend_id, @resend_status, @giro
  )
`);

let stats = { pool: 0, seguimiento: 0, descartados: 0, errores: 0 };

// ── 1. Migrar pool-verificado.json ──────────────────────────
const pool = loadJSON('pool-verificado.json');
if (pool && Array.isArray(pool)) {
  const migrarPool = db.transaction(() => {
    for (const p of pool) {
      try {
        insertProspecto.run({
          proyecto: 'creativa-balam',
          nombre: p.nombre || 'Desconocido',
          zona: p.zona || null,
          dominio: p.dominio || null,
          url: p.url || null,
          correo: p.correo || null,
          tipo_campana: p.tipo_campana || 'sitio_lento',
          dato_duro: p.dato_duro || (p.rend != null ? `rendimiento ${p.rend}/100, LCP ${p.lcp}s` : null),
          contexto_extra: p.contexto_extra ? JSON.stringify(p.contexto_extra) : (p.rend != null ? JSON.stringify({ rend: p.rend, lcp: p.lcp }) : null),
          rendimiento: p.rend ?? null,
          lcp: p.lcp ?? null,
          estado: 'pool',
          motivo_descarte: null,
          agregado_al_pool_at: p.agregado_al_pool || null,
          enviado_at: null,
          respondio_at: null,
          cita_at: null,
          cerrado_at: null,
          monto: null,
          nota: null,
          resend_id: null,
          resend_status: null,
          giro: p.giro || null,
        });
        stats.pool++;
      } catch (e) {
        console.error(`  ✗ pool: ${p.correo || p.dominio}: ${e.message}`);
        stats.errores++;
      }
    }
  });
  migrarPool();
  console.log(`✓ pool-verificado.json: ${stats.pool} registros migrados`);
}

// ── 2. Migrar seguimiento.json ──────────────────────────────
const seguimiento = loadJSON('seguimiento.json');
if (seguimiento && typeof seguimiento === 'object') {
  const migrarSeg = db.transaction(() => {
    for (const [correo, s] of Object.entries(seguimiento)) {
      try {
        const dominio = dominioFromCorreo(correo);
        const estado = mapEstadoEmbudo(s.estado_embudo, s.estado_entrega);
        insertProspecto.run({
          proyecto: 'creativa-balam',
          nombre: s.nombre || s.asunto || correo,
          zona: s.zona || null,
          dominio: dominio,
          url: s.url || null,
          correo: correo,
          tipo_campana: 'sitio_lento',
          dato_duro: s.asunto || null,
          contexto_extra: null,
          rendimiento: s.rendimiento ?? null,
          lcp: s.lcp ?? null,
          estado: estado,
          motivo_descarte: null,
          agregado_al_pool_at: null,
          enviado_at: s.fecha_envio || null,
          respondio_at: s.respondio_at || null,
          cita_at: s.cita_at || null,
          cerrado_at: s.cerrado_at || null,
          monto: s.monto ?? null,
          nota: s.nota || null,
          resend_id: s.resend_id || null,
          resend_status: s.estado_entrega || null,
          giro: s.giro || null,
        });
        stats.seguimiento++;
      } catch (e) {
        console.error(`  ✗ seguimiento: ${correo}: ${e.message}`);
        stats.errores++;
      }
    }
  });
  migrarSeg();
  console.log(`✓ seguimiento.json: ${stats.seguimiento} registros migrados`);
}

// ── 3. Migrar descartados-permanentes.json ──────────────────
const descartados = loadJSON('descartados-permanentes.json');
if (descartados && typeof descartados === 'object') {
  const migrarDesc = db.transaction(() => {
    for (const [dominio, motivo] of Object.entries(descartados)) {
      try {
        insertProspecto.run({
          proyecto: 'creativa-balam',
          nombre: dominio,
          zona: null,
          dominio: dominio,
          url: null,
          correo: null,
          tipo_campana: 'sitio_lento',
          dato_duro: null,
          contexto_extra: null,
          rendimiento: null,
          lcp: null,
          estado: 'descartado',
          motivo_descarte: motivo,
          agregado_al_pool_at: null,
          enviado_at: null,
          respondio_at: null,
          cita_at: null,
          cerrado_at: null,
          monto: null,
          nota: null,
          resend_id: null,
          resend_status: null,
          giro: null,
        });
        stats.descartados++;
      } catch (e) {
        console.error(`  ✗ descartado: ${dominio}: ${e.message}`);
        stats.errores++;
      }
    }
  });
  migrarDesc();
  console.log(`✓ descartados-permanentes.json: ${stats.descartados} registros migrados`);
}

// ── Resumen ─────────────────────────────────────────────────
console.log('\n═══ Resumen de migración ═══');
console.log(`  Pool:         ${stats.pool}`);
console.log(`  Seguimiento:  ${stats.seguimiento}`);
console.log(`  Descartados:  ${stats.descartados}`);
console.log(`  Total:        ${stats.pool + stats.seguimiento + stats.descartados}`);
console.log(`  Errores:      ${stats.errores}`);

// Verificación
const counts = db.prepare(`
  SELECT estado, COUNT(*) as n FROM prospectos GROUP BY estado ORDER BY n DESC
`).all();
console.log('\n═══ Verificación en panel.db ═══');
for (const r of counts) {
  console.log(`  ${r.estado}: ${r.n}`);
}
const total = db.prepare('SELECT COUNT(*) as n FROM prospectos').get();
console.log(`  TOTAL: ${total.n}`);

db.close();
console.log('\n✓ Migración completada. Archivos JSON originales intactos.');
