#!/usr/bin/env node
/**
 * AUTO-ALIMENTAR — Reposición automática del pool de prospectos (v1)
 *
 * Corre 2x al día (05:00 y 17:00, antes de pool-diario.js).
 *
 * Flujo:
 * 1. Leer pool-verificado.json → contar total
 * 2. Si total < umbral_pool Y auto_investigar == true:
 *    a. Correr detector-seo.js (módulo) → genera tipo invisible_google y sin_ads
 *    b. Correr pool-diario.js lógica → genera tipo sitio_lento
 *    c. Si aún bajo: encolar investigación automática vía agregarTarea()
 *    d. Notificar a Carlos por Telegram
 * 3. Límite: max 2 investigaciones automáticas por día
 *
 * Config: prospeccion-diaria/config/zonas-giros.json
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { notificar } = require('/root/agente-constructor/scripts/telegram-notify');
const { agregarTarea } = require('/root/agente-constructor/queue');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const POOL_PATH = path.join(BASE, 'pool-verificado.json');
const CONFIG_PATH = path.join(BASE, 'config', 'zonas-giros.json');
const HOY = new Date().toISOString().slice(0, 10);
const CONTADOR_PATH = path.join(BASE, `auto-investigaciones-${HOY}.json`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function leerPool() {
  if (!fs.existsSync(POOL_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function leerConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('⚠️ No existe zonas-giros.json, abortando auto-alimentar');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function contarInvestigacionesHoy() {
  if (!fs.existsSync(CONTADOR_PATH)) return { total: 0, registros: [] };
  try {
    return JSON.parse(fs.readFileSync(CONTADOR_PATH, 'utf8'));
  } catch {
    return { total: 0, registros: [] };
  }
}

function registrarInvestigacion(zona, giro) {
  const data = contarInvestigacionesHoy();
  data.total += 1;
  data.registros.push({ zona, giro, hora: new Date().toISOString() });
  fs.writeFileSync(CONTADOR_PATH, JSON.stringify(data, null, 2));
}

/**
 * Elige zona y giro con menos candidatos en el pool (round-robin).
 * Retorna { zona, giro } o null si no hay opciones.
 */
function elegirZonaGiro(pool, config) {
  const conteo = {};
  for (const zona of config.zonas_activas) {
    const giros = config.giros[zona] || [];
    for (const giro of giros) {
      const key = `${zona}|${giro}`;
      conteo[key] = 0;
    }
  }

  // Contar cuántos candidatos hay por zona+giro en el pool
  for (const c of pool) {
    const zona = (c.zona || '').toLowerCase();
    const giro = (c.contexto_extra && c.contexto_extra.giro) || '';
    const key = `${zona}|${giro}`;
    if (key in conteo) {
      conteo[key] += 1;
    }
  }

  // Encontrar el par con menos candidatos
  let minKey = null;
  let minCount = Infinity;
  for (const [key, count] of Object.entries(conteo)) {
    if (count < minCount) {
      minCount = count;
      minKey = key;
    }
  }

  if (!minKey) return null;
  const [zona, giro] = minKey.split('|');
  return { zona, giro };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const config = leerConfig();
  const pool = leerPool();
  const totalPool = pool.length;

  console.log(`[auto-alimentar] Pool actual: ${totalPool} candidatos, umbral: ${config.umbral_pool}`);

  if (totalPool >= config.umbral_pool) {
    console.log('[auto-alimentar] Pool por encima del umbral, nada que hacer.');
    return;
  }

  if (!config.auto_investigar) {
    console.log('[auto-alimentar] auto_investigar está desactivado. Solo se corren detectores con datos existentes.');
    await notificar(`⚠️ Pool bajo (${totalPool}/${config.umbral_pool}) pero auto_investigar está apagado. Usa /investigar para reponer.`);
    return;
  }

  console.log(`[auto-alimentar] Pool bajo (${totalPool}/${config.umbral_pool}), iniciando reposición...`);

  // ── Paso a: Correr detector-seo.js si existe ──────────────────────────────
  const detectorSeoPath = path.join(BASE, 'detector-seo.js');
  if (fs.existsSync(detectorSeoPath)) {
    try {
      console.log('[auto-alimentar] Corriendo detector-seo.js...');
      execSync(`node ${detectorSeoPath}`, {
        cwd: BASE,
        stdio: 'inherit',
        timeout: 120_000,
      });
    } catch (err) {
      console.error('[auto-alimentar] Error en detector-seo.js:', err.message);
    }
  } else {
    console.log('[auto-alimentar] detector-seo.js no existe aún, saltando.');
  }

  // ── Paso b: Correr pool-diario.js para generar tipo sitio_lento ───────────
  const poolDiarioPath = path.join(BASE, 'pool-diario.js');
  if (fs.existsSync(poolDiarioPath)) {
    try {
      console.log('[auto-alimentar] Corriendo pool-diario.js...');
      execSync(`node ${poolDiarioPath}`, {
        cwd: BASE,
        stdio: 'inherit',
        timeout: 180_000,
      });
    } catch (err) {
      console.error('[auto-alimentar] Error en pool-diario.js:', err.message);
    }
  }

  // ── Re-leer el pool después de los detectores ─────────────────────────────
  const poolActualizado = leerPool();
  const totalActualizado = poolActualizado.length;

  console.log(`[auto-alimentar] Pool después de detectores: ${totalActualizado}/${config.umbral_pool}`);

  if (totalActualizado >= config.umbral_pool) {
    console.log('[auto-alimentar] Pool repuesto con detectores. Listo.');
    await notificar(`✅ Auto-reposición completó pool: ${totalActualizado} candidatos (umbral: ${config.umbral_pool}).`);
    return;
  }

  // ── Paso c: Investigación automática si aún está bajo ─────────────────────
  const investigacionesHoy = contarInvestigacionesHoy();
  const limite = config.auto_investigar_limite_diario || 2;

  if (investigacionesHoy.total >= limite) {
    console.log(`[auto-alimentar] Ya se hicieron ${investigacionesHoy.total}/${limite} investigaciones hoy, no se encolan más.`);
    await notificar(
      `⚠️ Pool sigue bajo (${totalActualizado}/${config.umbral_pool}) y ya se alcanzó el límite de ${limite} auto-investigaciones hoy.`
    );
    return;
  }

  const target = elegirZonaGiro(poolActualizado, config);
  if (!target) {
    console.log('[auto-alimentar] No se pudo elegir zona/giro para investigar.');
    return;
  }

  const { zona, giro } = target;
  console.log(`[auto-alimentar] Encolando investigación automática: ${giro} en ${zona}`);

  // ── Paso d: Notificar y encolar ───────────────────────────────────────────
  await notificar(`🔄 Auto-reposición: buscando ${giro} en ${zona} (pool: ${totalActualizado}/${config.umbral_pool})`);

  try {
    await agregarTarea('investigadores', 'creativa-balam', `Auto-investigación: ${giro} en ${zona}`, {
      instrucciones: `Investiga negocios de ${giro} en ${zona} para prospección de Creativa Balam.

Busca negocios que:
1. Tengan presencia online (Google Maps, redes sociales, directorios)
2. De preferencia con sitio web propio (para medir rendimiento)
3. Con correo electrónico encontrable

Zona: ${zona}
Giro: ${giro}
Cantidad objetivo: al menos 10 negocios

Guarda el resultado en el formato estándar de investigación en:
vault/7-investigacion-mercado/creativa-balam/${zona}/${giro}-auto-${HOY}.md

Incluye para cada negocio: nombre, URL (si tiene), correo (si lo encuentras), dirección, y notas relevantes.`,
    });
    registrarInvestigacion(zona, giro);
    console.log(`[auto-alimentar] Investigación encolada: ${giro} en ${zona}`);
  } catch (err) {
    console.error('[auto-alimentar] Error al encolar investigación:', err.message);
    await notificar(`❌ Error al encolar auto-investigación de ${giro} en ${zona}: ${err.message}`);
  }
})().then(
  () => process.stdout.write('', () => process.exit(0)),
  (err) => { console.error('[error fatal]', err); process.stdout.write('', () => process.exit(1)); }
);
