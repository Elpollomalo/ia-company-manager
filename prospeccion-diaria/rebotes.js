#!/usr/bin/env node
/**
 * REPORTE DE REBOTES — qué se cayó, por qué, y qué tan sano va el envío.
 *
 * Resend/AWS miran la tasa de rebote del dominio: por arriba de ~5% empiezan a
 * limitar o suspender la cuenta, y eso tumba TODAS las campañas, no sólo la que
 * rebotó. Por eso el número que importa no es "cuántos rebotaron" sino el
 * porcentaje sobre lo enviado.
 *
 * Fuentes:
 *   rebotes.json  -> registro permanente (incluye la lista de supresión de Resend,
 *                    que no caduca; el historial de correos sí)
 *   panel.db      -> enviados totales, por mes y estados actuales
 *
 * Uso: node rebotes.js
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const REBOTES_PATH = path.join(BASE, 'rebotes.json');
const PANEL_DB = '/root/ponexo-root/panel.db';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const PRUEBA = /prueba|test|example|demo@/i;

function leerRebotes() {
  try { return JSON.parse(fs.readFileSync(REBOTES_PATH, 'utf8')); } catch { return { rebotes: {} }; }
}

function datosPanel() {
  const db = require('/root/ponexo-root/node_modules/better-sqlite3')(PANEL_DB, { readonly: true });
  const envios = db.prepare(`SELECT DISTINCT lower(correo) correo, substr(enviado_at,1,7) mes
                             FROM prospectos WHERE enviado_at IS NOT NULL AND correo IS NOT NULL`).all();
  const estados = db.prepare(`SELECT estado, COUNT(*) n FROM prospectos GROUP BY estado`).all();
  db.close();
  return { envios, estados };
}

const mes = f => (f ? String(f).slice(0, 7) : '');
const etiqueta = m => (m ? `${MESES[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}` : 'sin fecha');

const { esCompartido } = require('./lib/dominios');
const reg = leerRebotes();
const rebotes = Object.values(reg.rebotes || {})
  .sort((a, b) => String(b.fecha_envio || '').localeCompare(String(a.fecha_envio || '')));
const { envios, estados } = datosPanel();

const enviados = new Set(envios.map(e => e.correo)).size;
const reales = rebotes.filter(r => !PRUEBA.test(r.correo));
const dePrueba = rebotes.length - reales.length;
const permanentes = rebotes.filter(r => r.permanente).length;

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0.0');
const tasa = Number(pct(reales.length, enviados));
const semaforo = tasa > 5 ? '🔴 arriba del límite (5%)' : tasa > 3 ? '🟡 cerca del límite' : '🟢 sano';

// Por mes: envíos del panel contra rebotes del registro.
const porMes = {};
for (const e of envios) { const m = mes(e.mes + '-01'); porMes[m] = porMes[m] || { e: 0, r: 0 }; porMes[m].e++; }
for (const r of reales) { const m = mes(r.fecha_envio); porMes[m] = porMes[m] || { e: 0, r: 0 }; porMes[m].r++; }

const out = [];
out.push('📮 CONTROL DE REBOTES — Creativa Balam');
out.push('');
out.push(`Desde el primer envío (jul 2026) hasta hoy:`);
out.push(`  Correos enviados      : ${enviados}`);
out.push(`  Rebotes reales        : ${reales.length}${dePrueba ? `  (+${dePrueba} de prueba)` : ''}`);
out.push(`  Tasa global           : ${pct(reales.length, enviados)}%  ${semaforo}`);
out.push('');
out.push('Por mes (rebotes / enviados):');
for (const m of Object.keys(porMes).sort()) {
  const d = porMes[m];
  out.push(`  ${etiqueta(m).padEnd(8)} ${String(d.r).padStart(2)} / ${String(d.e).padStart(3)}`);
}
out.push('');
if (rebotes.length) {
  out.push('Detalle:');
  for (const r of rebotes) {
    const fecha = (r.fecha_envio || '').slice(0, 10) || '—';
    const tipo = r.permanente ? (r.diagnostico || 'permanente') : (r.diagnostico || '?');
    out.push(`  ${fecha}  ${r.correo}`);
    out.push(`      ${tipo} · ${(r.motivo || '').slice(0, 120)}`);
  }
  out.push('');
}
const dominiosBloqueados = [...new Set(rebotes.map(r => r.dominio).filter(d => d && !esCompartido(d)))];
const buzonesAislados = rebotes.filter(r => esCompartido(r.dominio)).map(r => r.correo);
out.push(`Dominios vetados (empresa): ${dominiosBloqueados.join(', ') || 'ninguno'}`);
out.push(`Buzones vetados en dominio compartido: ${buzonesAislados.join(', ') || 'ninguno'}`);
out.push('');
out.push(`Registro actualizado: ${reg.actualizado ? reg.actualizado.slice(0, 16).replace('T', ' ') : 'nunca'}`);

console.log(out.join('\n'));
