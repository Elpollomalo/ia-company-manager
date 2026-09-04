#!/usr/bin/env node
/**
 * PROSPECCIÓN DIARIA — RECOLECTOR
 *
 * Corre unos minutos después del orquestador (dale tiempo al agente
 * marketing de terminar, normalmente 2-4 min). Busca el correos.js que
 * el agente dejó en su ruta autorizada del vault y lo copia a
 * prospeccion-diaria/{HOY}/correos.js, que es lo que enviar-diario.js
 * y el comando "revisar" de Telegram esperan.
 *
 * Si lo encuentra: dispara el aviso "revisar" (borradores completos por
 * Telegram) o, en modo AUTO (fuera del período de evaluación), envía
 * directo.
 * Si no lo encuentra todavía: no hace nada (el próximo tick del cron
 * lo vuelve a intentar).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const HOY = new Date().toISOString().slice(0, 10);
const DIR_HOY = path.join(BASE, HOY);
const DESTINO = path.join(DIR_HOY, 'correos.js');

const INICIO_EVAL = '2026-08-26';
const DIAS_APROBACION = 5;
function enPeriodoAprobacion() {
  const dias = Math.floor((Date.now() - new Date(INICIO_EVAL + 'T00:00:00Z')) / 86400000);
  return dias < DIAS_APROBACION;
}

if (fs.existsSync(DESTINO)) {
  console.log('correos.js ya copiado, nada que hacer.');
  process.exit(0);
}

/**
 * El sandbox de escritura del agente reescribe la ruta pedida agregando
 * "-redaccion" a la carpeta y a veces anidando otra carpeta con el mismo
 * nombre adentro (visto en las corridas del 27 y 28 ago). En vez de asumir
 * una única ruta exacta, se busca recursivamente cualquier correos.js
 * dentro de la carpeta del día (incluida la variante "-redaccion") y se usa
 * el más reciente si hay más de uno.
 */
function buscarCorreosJs() {
  const candidatos = [
    path.join('/root/agente-constructor/vault/1-desk/creativa-balam/marketing', `prospeccion-diaria-${HOY}`, 'correos.js'),
    path.join('/root/agente-constructor/vault/1-desk/creativa-balam/marketing', `prospeccion-diaria-${HOY}-redaccion`, 'correos.js'),
    path.join('/root/agente-constructor/vault/1-desk/creativa-balam/marketing', `prospeccion-diaria-${HOY}-redaccion`, `prospeccion-diaria-${HOY}`, 'correos.js'),
  ];
  const existentes = candidatos.filter(p => fs.existsSync(p));
  if (existentes.length) {
    existentes.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return existentes[0];
  }
  // Último recurso: barrer toda la carpeta del agente buscando cualquier
  // correos.js que mencione la fecha de hoy en su ruta.
  const raiz = '/root/agente-constructor/vault/1-desk/creativa-balam/marketing';
  if (!fs.existsSync(raiz)) return null;
  const stack = [raiz];
  const hallados = [];
  while (stack.length) {
    const dir = stack.pop();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name.includes(HOY)) stack.push(p);
      else if (e.isFile() && e.name === 'correos.js' && p.includes(HOY)) hallados.push(p);
    }
  }
  if (!hallados.length) return null;
  hallados.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hallados[0];
}

const origen = buscarCorreosJs();
if (!origen) {
  console.log(`todavía no existe correos.js para ${HOY} en ninguna ruta conocida — el agente sigue redactando o no ha corrido.`);
  process.exit(0);
}

fs.mkdirSync(DIR_HOY, { recursive: true });
fs.copyFileSync(origen, DESTINO);
console.log(`copiado ${origen} -> ${DESTINO}`);
fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), enPeriodoAprobacion() ? 'ESPERANDO_APROBACION' : 'AUTO');

const script = enPeriodoAprobacion() ? 'revisar' : 'auto';
execFile('node', ['/root/agente-constructor/prospeccion-diaria/enviar-diario.js', script],
  { timeout: 1000 * 60 * 20 }, (err) => { if (err) console.error(err.message); });
