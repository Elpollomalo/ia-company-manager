#!/usr/bin/env node
/**
 * PROSPECCIÓN DIARIA — CONSTRUCTOR DE POOL VERIFICADO
 *
 * Corrige el problema de "si no encuentra correo o no pasa el filtro, ese
 * día manda menos de 4". En vez de filtrar al vuelo cada mañana, este
 * script mantiene un POOL de candidatos YA verificados (correo encontrado +
 * MX vivo + nunca contactados) del que el orquestador simplemente saca 4.
 *
 * Se corre seguido (cron cada varias horas) y va reponiendo el pool hasta
 * un mínimo (UMBRAL_MINIMO). Cuando después de recorrer TODAS las zonas
 * medidas no logra mantener el mínimo, avisa por Telegram para que Carlos
 * autorice una investigación/auditoría nueva con /investigar.
 *
 * Archivo de pool: prospeccion-diaria/pool-verificado.json
 *   [{ nombre, zona, url, dominio, rend, lcp, correo }, ...]
 * Consumido (FIFO) por orquestador-diario.js.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { notificar, escaparHtml } = require('/root/agente-constructor/scripts/telegram-notify');

const VAULT_AUDITORIA = '/root/agente-constructor/vault/9-auditoria-web/creativa-balam';
const VAULT_INVESTIGACION = '/root/agente-constructor/vault/7-investigacion-mercado/creativa-balam';
const ZONAS_CONOCIDAS = ['cozumel', 'cancun', 'playa-del-carmen', 'bacalar', 'merida', 'tulum', 'progreso'];
const BASE = '/root/agente-constructor/prospeccion-diaria';
const POOL_PATH = path.join(BASE, 'pool-verificado.json');
const DESCARTADOS_PATH = path.join(BASE, 'descartados-permanentes.json'); // dominios que nunca calificarán (sin MX, ya contactados, etc.) — no se re-intentan cada corrida
const UMBRAL_MINIMO = 12; // si el pool baja de esto, se repone; si no se puede, se avisa

function leerJson(p, porDefecto) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return porDefecto; } }
function guardarJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

function leerInformes(zona) {
  const dir = path.join(VAULT_AUDITORIA, zona);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
    .map(f => path.join(dir, f));
}

function parsearNegocios(archivo, zona) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const negocios = [];
  const bloques = texto.split(/^### /m).slice(1);
  for (const b of bloques) {
    const nombre = (b.split('\n')[0] || '').replace(/^\d+\.\s*/, '').replace(/^[^\wÑñÁ-ú]+/, '').trim();
    const urlRaw = (b.match(/URL:\*\*\s*(\S+)/) || b.match(/URL:\s*(\S+)/) || [])[1];
    const url = urlRaw && urlRaw.replace(/^\*+|\*+$/g, '');
    const rend = parseInt((b.match(/(\d+)\/100/) || [])[1]);
    const lcpTxt = (b.match(/LCP:.*?([\d.]+)\s*s/) || [])[1];
    if (!nombre || !url || isNaN(rend)) continue;
    if (/ueniweb|wixsite|business\.site|godaddysites/.test(url)) continue;
    negocios.push({ zona, nombre, url, rend, lcp: parseFloat(lcpTxt) || null });
  }
  return negocios;
}

// ── Candidatos que salen de /investigar (vault/7-investigacion-mercado) ──
// El agente `investigadores` ya trae correo verificado pero NUNCA mide
// rendimiento/LCP real (no corre PageSpeed) -- por eso estos candidatos no
// entraban nunca al pool aunque las investigaciones sí encontraban negocios
// nuevos. Aquí se miden antes de aplicar el mismo filtro que ya usa el
// camino de auditoría web.
function listarInformesInvestigacion() {
  if (!fs.existsSync(VAULT_INVESTIGACION)) return [];
  const resultado = [];
  for (const carpeta of fs.readdirSync(VAULT_INVESTIGACION)) {
    const dirCompleto = path.join(VAULT_INVESTIGACION, carpeta);
    if (!fs.statSync(dirCompleto).isDirectory()) continue;
    for (const f of fs.readdirSync(dirCompleto)) {
      if (f.endsWith('.md')) resultado.push(path.join(dirCompleto, f));
    }
  }
  return resultado;
}

function inferirZona(archivo) {
  const ruta = archivo.toLowerCase();
  return ZONAS_CONOCIDAS.find(z => ruta.includes(z)) || 'desconocida';
}

// Los informes de investigadores traen tablas markdown, no bloques "### ":
// | Negocio | URL | Email | Teléfono | Notas de sitio |
function parsearInvestigacion(archivo) {
  const lineas = fs.readFileSync(archivo, 'utf8').split('\n');
  const zona = inferirZona(archivo);
  const negocios = [];
  for (let i = 0; i < lineas.length; i++) {
    if (!/^\|.*negocio.*\|.*url.*\|/i.test(lineas[i])) continue;
    if (!/^\|[\s:-]+\|/.test(lineas[i + 1] || '')) continue;
    for (let j = i + 2; j < lineas.length; j++) {
      if (!/^\|.*\|$/.test(lineas[j])) break;
      const [nombreRaw, urlRaw, correoRaw] = lineas[j].split('|').slice(1, -1).map(c => (c || '').trim());
      const nombre = (nombreRaw || '').replace(/[*_]/g, '').trim();
      const url = (urlRaw || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].replace(/[*_]/g, '').trim();
      const correo = (correoRaw || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0] || null;
      if (!nombre || !url || !/\.[a-z]{2,}$/i.test(url)) continue;
      negocios.push({ zona, nombre, url, correo });
    }
  }
  return negocios;
}

async function medirVelocidad(dominio) {
  try {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent('https://' + dominio)}&strategy=mobile&category=performance&key=${process.env.PAGESPEED_API_KEY}`;
    const r = await fetch(api, { signal: AbortSignal.timeout(45000) });
    const j = await r.json();
    if (!j.lighthouseResult) return null;
    const c = j.lighthouseResult.categories, a = j.lighthouseResult.audits;
    const rend = Math.round((c.performance?.score ?? 0) * 100);
    const lcpMs = a['largest-contentful-paint']?.numericValue;
    if (isNaN(rend)) return null;
    return { rend, lcp: lcpMs ? Math.round(lcpMs / 100) / 10 : null };
  } catch {
    return null;
  }
}

function tieneMx(dominio) {
  try {
    const out = execSync(`dig +short MX ${dominio} @8.8.8.8`, { timeout: 8000 }).toString().trim();
    if (out) return true;
  } catch {}
  // Fallback: registro A + puerto 25 (algunos dominios usan MX implícito, ver caso jolly.coffee)
  try {
    execSync(`timeout 6 bash -c "echo > /dev/tcp/${dominio}/25"`, { timeout: 8000, shell: '/bin/bash' });
    return true;
  } catch { return false; }
}

function buscarCorreo(dominio) {
  try {
    const out = execSync(
      `grep -rhoE "[a-zA-Z0-9._%+-]+@${dominio.replace(/\./g, '\\.')}" /root/agente-constructor/vault/7-prospeccion-negocios/ 2>/dev/null | sort -u | head -3`,
      { timeout: 15000 }).toString().trim();
    if (out) return out.split('\n')[0];
  } catch {}
  try {
    const out = execSync(
      `curl -sL --max-time 20 "https://${dominio}" "https://www.${dominio}" 2>/dev/null | grep -oiE "[a-zA-Z0-9._%+-]+@${dominio.replace(/\./g, '\\.')}" | head -1`,
      { timeout: 30000, shell: '/bin/bash' }).toString().trim();
    if (out) return out;
  } catch {}
  return null;
}

async function historialResend() {
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
      if (d) {
        vistos[d.toLowerCase()] = true;
        const dom = d.toLowerCase().split('@')[1];
        if (dom) dominiosVistos.add(dom);
      }
    });
    if (j.data.length < 100) break;
    after = j.data[j.data.length - 1].id;
  }
  return { vistos, dominiosVistos };
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const pool = leerJson(POOL_PATH, []);
  const descartados = leerJson(DESCARTADOS_PATH, {}); // dominio -> motivo

  if (pool.length >= UMBRAL_MINIMO) {
    console.log(`Pool en ${pool.length}, por encima del mínimo (${UMBRAL_MINIMO}). Nada que hacer.`);
    return;
  }

  const zonas = fs.readdirSync(VAULT_AUDITORIA).filter(f => fs.statSync(path.join(VAULT_AUDITORIA, f)).isDirectory());
  let todos = [];
  for (const z of zonas) for (const a of leerInformes(z)) todos.push(...parsearNegocios(a, z));

  const porDominio = {};
  for (const n of todos) {
    const dom = n.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    porDominio[dom] = n;
  }

  const { vistos: historial, dominiosVistos } = await historialResend();
  const enPool = new Set(pool.map(p => p.dominio));
  let agregados = 0;

  for (const [dom, n] of Object.entries(porDominio)) {
    if (pool.length + agregados >= UMBRAL_MINIMO + 8) break; // no sobrecargar de una corrida
    if (enPool.has(dom) || descartados[dom]) continue;
    // Dedup por DOMINIO, no solo por correo exacto: un mismo negocio con
    // varios buzones (wecare@ vs hectorh@loscincosoles.com) no debe
    // recibir un segundo correo aunque cambie el destinatario.
    if (dominiosVistos.has(dom)) { descartados[dom] = 'dominio_ya_contactado'; continue; }

    const esCaso = n.rend < 65 || (n.lcp && n.lcp > 6);
    if (!esCaso) { descartados[dom] = 'buen_estado'; continue; }

    const correo = buscarCorreo(dom);
    if (!correo) { descartados[dom] = 'sin_correo_encontrado'; continue; }
    if (historial[correo.toLowerCase()]) { descartados[dom] = 'ya_contactado'; continue; }
    if (!tieneMx(dom)) { descartados[dom] = 'sin_mx'; continue; }

    pool.push({ ...n, dominio: dom, correo, agregado_al_pool: new Date().toISOString() });
    agregados++;
  }

  // ── Segundo camino: candidatos de /investigar, midiendo en vivo ──────────
  let medidos = 0;
  if (pool.length + agregados < UMBRAL_MINIMO + 8) {
    const candidatosInvestigacion = {};
    for (const archivo of listarInformesInvestigacion()) {
      for (const n of parsearInvestigacion(archivo)) {
        if (!candidatosInvestigacion[n.url]) candidatosInvestigacion[n.url] = n;
      }
    }
    for (const [dom, n] of Object.entries(candidatosInvestigacion)) {
      if (pool.length + agregados >= UMBRAL_MINIMO + 8) break;
      if (enPool.has(dom) || descartados[dom] || porDominio[dom]) continue; // ya resuelto por este camino o el otro
      if (dominiosVistos.has(dom)) { descartados[dom] = 'dominio_ya_contactado'; continue; }
      if (!n.correo) { descartados[dom] = 'sin_correo_encontrado'; continue; }
      if (historial[n.correo.toLowerCase()]) { descartados[dom] = 'ya_contactado'; continue; }
      if (!tieneMx(dom)) { descartados[dom] = 'sin_mx'; continue; }

      const medida = await medirVelocidad(dom);
      medidos++;
      await new Promise(r => setTimeout(r, 800));
      if (!medida) continue; // fallo de medición (no permanente): se reintenta en la próxima corrida

      const esCaso = medida.rend < 65 || (medida.lcp && medida.lcp > 6);
      if (!esCaso) { descartados[dom] = 'buen_estado'; continue; }

      pool.push({ zona: n.zona, nombre: n.nombre, url: `https://${dom}`, rend: medida.rend, lcp: medida.lcp, dominio: dom, correo: n.correo, agregado_al_pool: new Date().toISOString() });
      agregados++;
    }
  }

  guardarJson(POOL_PATH, pool);
  guardarJson(DESCARTADOS_PATH, descartados);
  console.log(`Pool: ${pool.length} (+${agregados} nuevos, ${medidos} medidos de /investigar). Descartados permanentes: ${Object.keys(descartados).length}.`);

  if (pool.length < UMBRAL_MINIMO) {
    await notificar(
`⚠️ <b>Pool de prospectos bajo</b>: quedan ${pool.length} candidatos verificados (mínimo deseado: ${UMBRAL_MINIMO}).

Ya se agotaron los negocios medidos disponibles en las zonas con auditoría web. Para seguir mandando 4 correos diarios hace falta más materia prima.

Autoriza una investigación o auditoría nueva:
<code>/investigar auditoria web zona {nombre}</code>
o
<code>/investigar prospección negocios {zona nueva}</code>`, { html: true });
  }
})();
