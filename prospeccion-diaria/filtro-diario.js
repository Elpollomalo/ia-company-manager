#!/usr/bin/env node
/**
 * PROSPECCION DIARIA — PASO 1: FILTRO
 *
 * Recorre las zonas con auditoria web en el vault, saca los negocios medidos
 * que cumplen TODOS estos filtros, y deja una lista corta de candidatos.
 *
 * Filtros (las reglas de la casa):
 *  · Con correo detectado
 *  · Nunca contactado antes (API de Resend, fuente de verdad)
 *  · No rebotado nunca (cada rebote dana el dominio)
 *  · MX del dominio verificable (dig)
 *  · Caso real de venta: rendimiento < 65/100 O LCP > 6 s
 *
 * Salida: /root/agente-constructor/prospeccion-diaria/candidatos-hoy.json
 *         + imprime resumen para Telegram.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VAULT_AUDITORIA = '/root/agente-constructor/vault/9-auditoria-web/creativa-balam';
const SALIDA = '/root/agente-constructor/prospeccion-diaria';
const EXCLUIDAS_DE_CANDIDATOS = new Set(['galeria-azul-analisis-tecnico.md']);
// Archivos de estudio que ya fueron consumidos por tandas manuales; su gente ya salio o esta lista abajo.
const YA_PROCESADOS_A_MANO = new Set([
  // Tandas 1-3 y tanda 4 (26 ago): todos los correos enviados por Resend los cubre
  // el filtro de historial, asi que aqui no hace falta mantener lista.
]);

function leerInformes(zona) {
  const dir = path.join(VAULT_AUDITORIA, zona);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .map(f => path.join(dir, f));
}

/** Parsea bloques "### Nombre ... - URL: ... LCP: X s ..." del informe. */
function parsearNegocios(archivo, zona) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const negocios = [];
  const bloques = texto.split(/^### /m).slice(1);
  for (const b of bloques) {
    const nombre = (b.split('\n')[0] || '').replace(/^\d+\.\s*/, '').replace(/^[^\wÑñÁ-ú]+/, '').trim();
    const url = (b.match(/URL:\*\*\s*(\S+)/) || b.match(/URL:\s*(\S+)/) || [])[1];
    const limpio = (u) => u && u.replace(/^\*+|\*+$/g, '');
    const rend = parseInt((b.match(/(\d+)\/100/) || [])[1]);
    const lcpTxt = (b.match(/LCP:.*?([\d.]+)\s*s/) || [])[1];
    if (!nombre || !url || isNaN(rend)) continue;
    // Solo dominios propios: los .ueniweb.com etc. son mini-sitios de plantilla sin dueño local alcanzable.
    if (/ueniweb|wixsite|business\.site|godaddysites/.test(url)) continue;
    negocios.push({ zona, nombre, url: limpio(url), rend, lcp: parseFloat(lcpTxt) || null });
  }
  return negocios;
}

function tieneMx(dominio) {
  try {
    const out = execSync(`dig +short MX ${dominio} @8.8.8.8`, { timeout: 8000 }).toString().trim();
    return out.length > 0;
  } catch { return false; }
}

async function historialResend() {
  const PROPIOS = /carlos\.salazar\.balam@gmail|balamcozu@proton|gnga\.web3@proton/i;
  const vistos = {};   // email -> {fecha, estado}
  let after = null;
  for (let i = 0; i < 10; i++) {
    const r = await fetch('https://api.resend.com/emails?limit=100' + (after ? '&after=' + after : ''),
      { headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY } });
    const j = await r.json();
    if (!j.data || !j.data.length) break;
    j.data.forEach(e => {
      const d = (e.to || [])[0];
      if (d && !PROPIOS.test(d)) {
        const previo = vistos[d.toLowerCase()];
        vistos[d.toLowerCase()] = {
          fecha: e.created_at.slice(0, 10),
          estado: e.last_event || 'sent',
          rebotes: (previo?.rebotes || 0) + (e.last_event === 'bounced' ? 1 : 0),
        };
      }
    });
    if (j.data.length < 100) break;
    after = j.data[j.data.length - 1].id;
  }
  return vistos;
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  const zonas = fs.readdirSync(VAULT_AUDITORIA).filter(f =>
    fs.statSync(path.join(VAULT_AUDITORIA, f)).isDirectory() && !EXCLUIDAS_DE_CANDIDATOS.has(f));

  // 1. Todos los negocios medidos en todos los informes de auditoria
  let todos = [];
  for (const z of zonas) for (const a of leerInformes(z)) todos.push(...parsearNegocios(a, z));

  // Dedupe por dominio (queda la medicion mas reciente)
  const porDominio = {};
  for (const n of todos) {
    const dom = n.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    porDominio[dom] = n; // los archivos van en orden de viejo a nuevo
  }

  // 2. Historial Resend
  const historial = await historialResend();

  // 3. Filtros
  const candidatos = [];
  const descartados = { contactados: [], rebotados: [], sin_mx: [], buen_estado: [], sin_correo_en_informe: [] };
  for (const [dom, n] of Object.entries(porDominio)) {
    const h = historial[dom]; // match por dominio: cualquier correo del mismo dominio cuenta
    const correosDominio = Object.keys(historial).filter(e => e.endsWith('@' + dom));
    if (correosDominio.length) {
      const algunoRebote = correosDominio.some(e => historial[e].estado === 'bounced');
      (algunoRebote ? descartados.rebotados : descartados.contactados).push(`${n.nombre} (${dom})`);
      continue;
    }
    const esCaso = n.rend < 65 || (n.lcp && n.lcp > 6);
    if (!esCaso) { descartados.buen_estado.push(n.nombre); continue; }
    if (!tieneMx(dom)) { descartados.sin_mx.push(n.nombre); continue; }
    candidatos.push({ ...n, dominio: dom });
  }

  candidatos.sort((a, b) => (a.rend - b.rend) || ((b.lcp||0) - (a.lcp||0)));

  const resultado = {
    generado: new Date().toISOString(),
    total_medidos: Object.keys(porDominio).length,
    candidatos: candidatos.slice(0, 12),
    descartados,
  };
  fs.writeFileSync(path.join(SALIDA, 'candidatos-hoy.json'), JSON.stringify(resultado, null, 2));

  console.log(`Medidos: ${resultado.total_medidos} | Candidatos vivos: ${candidatos.length}`);
  console.log(candidatos.slice(0, 12).map((c,i) => `${i+1}. ${c.nombre} (${c.zona}) ${c.rend}/100 LCP ${c.lcp||'?'}s ${c.url}`).join('\n'));
})();
