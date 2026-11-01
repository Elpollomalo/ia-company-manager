#!/usr/bin/env node
/**
 * DETECTOR SEO — Negocios invisibles en Google + detección de ads
 *
 * Usa Serper.dev para consultar Google SERPs y detectar:
 * 1. Negocios del vault que NO aparecen en top 10 orgánicos → tipo 'invisible_google'
 * 2. Competidores con ads activos → negocios del mismo giro sin ads → tipo 'sin_ads'
 *
 * CRÉDITOS LIMITADOS: máximo 20 búsquedas por corrida (configurable en busquedas-seo.json).
 * Se rotan las queries entre corridas para cubrir todo sin agotar créditos.
 *
 * Resultados van a pool-verificado.json con formato v2.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const { esNombreValido, negociosDeTablas } = require('./lib/nombres');
const CONFIG_PATH = path.join(BASE, 'config/busquedas-seo.json');
const POOL_PATH = path.join(BASE, 'pool-verificado.json');
const DESCARTADOS_PATH = path.join(BASE, 'descartados-permanentes.json');
const VAULT_PROSPECCION = '/root/agente-constructor/vault/7-prospeccion-negocios';
const VAULT_INVESTIGACION = '/root/agente-constructor/vault/7-investigacion-mercado/creativa-balam';
const ESTADO_PATH = path.join(BASE, 'config/estado-seo.json'); // rotación de queries

const GENERICOS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.es', 'hotmail.com.mx',
  'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'yahoo.com', 'yahoo.com.mx', 'yahoo.es',
  'icloud.com', 'me.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);

function leerJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function guardarJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

// ── Cargar negocios conocidos del vault ─────────────────────────────────────
function cargarNegociosVault() {
  const negocios = []; // { nombre, dominio, zona, giro, correo }

  // 1. vault/7-prospeccion-negocios — archivos .md con tablas o listas
  if (fs.existsSync(VAULT_PROSPECCION)) {
    for (const entry of recorrerDirectorio(VAULT_PROSPECCION)) {
      if (!entry.endsWith('.md')) continue;
      try {
        const texto = fs.readFileSync(entry, 'utf8');
        const zona = inferirZona(entry);
        // Tablas markdown: las columnas se localizan por encabezado (ver lib/nombres.js)
        for (const n of negociosDeTablas(texto)) {
          if (!n.dominio) continue;
          negocios.push({ nombre: n.nombre, dominio: n.dominio, zona, correo: n.correo });
        }
        // Bloques ### con URL:
        const bloques = texto.split(/^### /m).slice(1);
        for (const b of bloques) {
          const nombreCrudo = (b.split('\n')[0] || '').replace(/^\d+\.\s*/, '').replace(/^[^\wÑñÁ-ú]+/, '').trim();
          const urlMatch = b.match(/URL:\*?\*?\s*(https?:\/\/\S+)/i) || b.match(/URL:\s*(\S+)/i);
          if (!nombreCrudo || !urlMatch) continue;
          if (!esNombreValido(nombreCrudo)) continue;
          const dom = extraerDominio(urlMatch[1]);
          const correoMatch = b.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (dom) negocios.push({ nombre: nombreCrudo, dominio: dom, zona, correo: correoMatch?.[0] || null });
        }
      } catch {}
    }
  }

  // 2. vault/7-investigacion-mercado
  if (fs.existsSync(VAULT_INVESTIGACION)) {
    for (const entry of recorrerDirectorio(VAULT_INVESTIGACION)) {
      if (!entry.endsWith('.md')) continue;
      try {
        const texto = fs.readFileSync(entry, 'utf8');
        const zona = inferirZona(entry);
        for (const n of negociosDeTablas(texto)) {
          if (!n.dominio) continue;
          negocios.push({ nombre: n.nombre, dominio: n.dominio, zona, correo: n.correo });
        }
      } catch {}
    }
  }

  // Dedup por dominio, quedándose con el que tenga más datos
  const porDom = {};
  for (const n of negocios) {
    if (!porDom[n.dominio] || (n.correo && !porDom[n.dominio].correo)) {
      porDom[n.dominio] = n;
    }
  }
  return porDom;
}

function recorrerDirectorio(dir) {
  const resultados = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) resultados.push(...recorrerDirectorio(full));
      else resultados.push(full);
    }
  } catch {}
  return resultados;
}

function extraerDominio(url) {
  return (url || '').replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0].replace(/[*_\s]/g, '').toLowerCase();
}

const ZONAS_CONOCIDAS = ['cozumel', 'cancun', 'playa-del-carmen', 'bacalar', 'merida', 'tulum', 'progreso'];
function inferirZona(archivo) {
  const ruta = archivo.toLowerCase();
  return ZONAS_CONOCIDAS.find(z => ruta.includes(z)) || 'desconocida';
}

// ── Serper API ──────────────────────────────────────────────────────────────
async function buscarSerper(query, config) {
  const body = {
    q: query,
    gl: config.gl || 'mx',
    hl: config.hl || 'es',
    num: config.num || 10
  };
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Dedup: historial Resend ─────────────────────────────────────────────────
async function historialResend() {
  const vistos = {};
  const dominiosVistos = new Set();
  let after = null;
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch('https://api.resend.com/emails?limit=100' + (after ? '&after=' + after : ''),
        { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } });
      const j = await r.json();
      if (!j.data || !j.data.length) break;
      j.data.forEach(e => {
        const d = (e.to || [])[0];
        if (d) {
          vistos[d.toLowerCase()] = true;
          const dom = d.toLowerCase().split('@')[1];
          if (dom) dominiosVistos.add(dom);
        }
      });
      if (j.data.length < 100) break;
      after = j.data[j.data.length - 1].id;
    } catch (err) {
      console.error('Error consultando Resend:', err.message);
      break;
    }
  }
  return { vistos, dominiosVistos };
}

// ── Buscar correo ───────────────────────────────────────────────────────────
function buscarCorreo(dominio) {
  // Primero en el vault
  try {
    const out = execSync(
      `grep -rhoE "[a-zA-Z0-9._%+-]+@${dominio.replace(/\./g, '\\.')}\" /root/agente-constructor/vault/ 2>/dev/null | sort -u | head -3`,
      { timeout: 15000 }).toString().trim();
    if (out) return out.split('\n')[0];
  } catch {}
  return null;
}

function tieneMx(dominio) {
  try {
    const out = execSync(`dig +short MX ${dominio} @8.8.8.8`, { timeout: 8000 }).toString().trim();
    if (out) return true;
  } catch {}
  try {
    execSync(`timeout 6 bash -c "echo > /dev/tcp/${dominio}/25"`, { timeout: 8000, shell: '/bin/bash' });
    return true;
  } catch { return false; }
}

// ── Rotación de queries (para no gastar todos los créditos en una corrida) ──
function seleccionarQueries(config) {
  const estado = leerJson(ESTADO_PATH, { offset: 0 });
  const max = config.max_busquedas_por_corrida || 20;

  // Aplanar todas las queries con su metadata
  const todas = [];
  for (const grupo of config.busquedas) {
    for (const q of grupo.queries) {
      todas.push({ query: q, zona: grupo.zona, giro: grupo.giro });
    }
  }

  if (todas.length === 0) return { queries: [], nuevoOffset: 0 };

  // Seleccionar desde offset, rotando
  const offset = estado.offset % todas.length;
  const seleccionadas = [];
  for (let i = 0; i < Math.min(max, todas.length); i++) {
    seleccionadas.push(todas[(offset + i) % todas.length]);
  }

  const nuevoOffset = (offset + seleccionadas.length) % todas.length;
  return { queries: seleccionadas, nuevoOffset };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.SERPER_API_KEY) {
    console.error('❌ SERPER_API_KEY no configurada en .env');
    process.exit(1);
  }

  const config = leerJson(CONFIG_PATH, null);
  if (!config) {
    console.error('❌ No se pudo leer', CONFIG_PATH);
    process.exit(1);
  }

  console.log('🔍 Detector SEO iniciando...');

  // Cargar negocios del vault
  const negociosVault = cargarNegociosVault();
  const totalVault = Object.keys(negociosVault).length;
  console.log(`📦 ${totalVault} negocios cargados del vault`);

  // Cargar pool y descartados existentes
  const pool = leerJson(POOL_PATH, []);
  const descartados = leerJson(DESCARTADOS_PATH, {});
  const enPool = new Set(pool.map(p => p.dominio));

  // Historial Resend para dedup
  const { vistos: historial, dominiosVistos } = await historialResend();
  console.log(`📧 ${Object.keys(historial).length} correos en historial Resend`);

  // Seleccionar queries para esta corrida
  const { queries: querysBatch, nuevoOffset } = seleccionarQueries(config);
  console.log(`🔎 ${querysBatch.length} búsquedas programadas para esta corrida`);

  const resultadosSeo = []; // acumula hallazgos antes de filtrar
  const competidoresConAds = {}; // giro+zona -> [{ nombre, dominio }]
  let busquedasHechas = 0;

  for (const item of querysBatch) {
    try {
      console.log(`  → "${item.query}" (${item.zona}/${item.giro})`);
      const serp = await buscarSerper(item.query, config);
      busquedasHechas++;

      const organicos = (serp.organic || []).map(r => ({
        titulo: r.title,
        dominio: extraerDominio(r.link),
        url: r.link,
        posicion: r.position
      }));

      const ads = (serp.ads || []).map(r => ({
        titulo: r.title,
        dominio: extraerDominio(r.link),
        url: r.link
      }));

      const dominiosOrganicos = new Set(organicos.map(o => o.dominio));
      const dominiosAds = new Set(ads.map(a => a.dominio));

      // 1. Negocios del vault que NO aparecen en top 10 → invisible_google
      for (const [dom, neg] of Object.entries(negociosVault)) {
        // Solo negocios de la misma zona
        if (neg.zona !== item.zona && neg.zona !== 'desconocida') continue;

        if (!dominiosOrganicos.has(dom) && !dominiosOrganicos.has('www.' + dom)) {
          resultadosSeo.push({
            tipo_campana: 'invisible_google',
            nombre: neg.nombre,
            dominio: dom,
            // La zona del informe del vault suele ser 'desconocida' porque se
            // infiere del nombre del archivo. Si es el caso, vale más la zona
            // de la BÚSQUEDA que lo encontró: de ella depende que el correo
            // pida visita local o videollamada.
            zona: (neg.zona && neg.zona !== 'desconocida') ? neg.zona : item.zona,
            giro: item.giro || neg.giro,
            correo: neg.correo,
            dato_duro: `No aparece en top 10 de Google para "${item.query}"`,
            contexto_extra: `${organicos.length} resultados orgánicos analizados. Competidores posicionados: ${organicos.slice(0, 3).map(o => o.dominio).join(', ')}`
          });
        }
      }

      // 2. Registrar quién tiene ads
      if (ads.length > 0) {
        const key = `${item.giro}:${item.zona}`;
        if (!competidoresConAds[key]) competidoresConAds[key] = [];
        for (const ad of ads) {
          competidoresConAds[key].push({
            dominio: ad.dominio,
            titulo: ad.titulo,
            query: item.query
          });
        }

        // Negocios del vault del mismo giro/zona que NO tienen ads → sin_ads
        for (const [dom, neg] of Object.entries(negociosVault)) {
          if (neg.zona !== item.zona && neg.zona !== 'desconocida') continue;
          if (!dominiosAds.has(dom) && !dominiosAds.has('www.' + dom)) {
            resultadosSeo.push({
              tipo_campana: 'sin_ads',
              nombre: neg.nombre,
              dominio: dom,
              zona: (neg.zona && neg.zona !== 'desconocida') ? neg.zona : item.zona,
              giro: item.giro || neg.giro,
              correo: neg.correo,
              dato_duro: `Su competencia paga ads en "${item.query}" y ${neg.nombre} no`,
              contexto_extra: `Anunciantes activos: ${ads.map(a => a.dominio).join(', ')}`
            });
          }
        }
      }

      // Rate limit: 500ms entre búsquedas
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  ✗ Error en "${item.query}":`, err.message);
    }
  }

  // Guardar offset para rotación
  guardarJson(ESTADO_PATH, { offset: nuevoOffset, ultima_corrida: new Date().toISOString(), busquedas_hechas: busquedasHechas });

  // ── Dedup y filtrar resultados ────────────────────────────────────────────
  // Un mismo negocio puede aparecer como invisible en múltiples queries.
  // Quedarse con el más relevante (dato_duro más específico).
  const mejorPorDominio = {};
  for (const r of resultadosSeo) {
    const key = `${r.dominio}:${r.tipo_campana}`;
    if (!mejorPorDominio[key]) {
      mejorPorDominio[key] = r;
    }
    // Preferir sin_ads sobre invisible (es más accionable)
    if (mejorPorDominio[key].tipo_campana === 'invisible_google' && r.tipo_campana === 'sin_ads') {
      mejorPorDominio[key] = r;
    }
  }

  // Filtrar: excluir ya en pool, descartados, ya contactados
  let agregados = 0;
  for (const [key, candidato] of Object.entries(mejorPorDominio)) {
    const dom = candidato.dominio;

    if (enPool.has(dom)) continue;
    if (descartados[dom]) continue;
    if (dominiosVistos.has(dom)) { descartados[dom] = 'dominio_ya_contactado'; continue; }

    // Buscar correo si no lo tiene
    let correo = candidato.correo;
    if (!correo) {
      correo = buscarCorreo(dom);
    }
    if (!correo) {
      // No descartar permanentemente: puede aparecer después
      continue;
    }
    if (historial[correo.toLowerCase()]) { descartados[dom] = 'ya_contactado'; continue; }

    const domCorreo = correo.toLowerCase().split('@')[1];
    if (!GENERICOS.has(domCorreo) && dominiosVistos.has(domCorreo)) {
      descartados[dom] = 'dominio_ya_contactado';
      continue;
    }
    if (!tieneMx(domCorreo)) { descartados[dom] = 'sin_mx'; continue; }

    // Agregar al pool con formato v2
    pool.push({
      nombre: candidato.nombre,
      zona: candidato.zona,
      dominio: dom,
      correo,
      tipo_campana: candidato.tipo_campana,
      giro: candidato.giro,
      dato_duro: candidato.dato_duro,
      contexto_extra: candidato.contexto_extra,
      fuente: 'detector_seo',
      agregado_al_pool: new Date().toISOString()
    });
    enPool.add(dom);
    agregados++;
  }

  guardarJson(POOL_PATH, pool);
  guardarJson(DESCARTADOS_PATH, descartados);

  // Resumen
  const totalInvisibles = Object.values(mejorPorDominio).filter(r => r.tipo_campana === 'invisible_google').length;
  const totalSinAds = Object.values(mejorPorDominio).filter(r => r.tipo_campana === 'sin_ads').length;
  const girosConAds = Object.keys(competidoresConAds).length;

  console.log(`\n📊 Resumen detector SEO:`);
  console.log(`   Búsquedas realizadas: ${busquedasHechas}`);
  console.log(`   Negocios invisibles encontrados: ${totalInvisibles}`);
  console.log(`   Negocios sin ads (competencia sí tiene): ${totalSinAds}`);
  console.log(`   Giros con ads activos detectados: ${girosConAds}`);
  console.log(`   Nuevos candidatos al pool: ${agregados}`);
  console.log(`   Pool total: ${pool.length}`);
  console.log(`   Descartados permanentes: ${Object.keys(descartados).length}`);
})();
