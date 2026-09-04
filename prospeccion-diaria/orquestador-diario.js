#!/usr/bin/env node
/**
 * PROSPECCIÓN DIARIA — ORQUESTADOR (v2, corrige los 3 bugs del 26-27 ago)
 *
 * Bug 1 (arreglado): el agente marketing solo puede escribir en
 *   vault/1-desk, vault/6-web-notes, vault/8-imagenes-generadas,
 *   vault/sources/creativa-balam/prospectos (ver agents/marketing.md).
 *   Antes le pedíamos escribir en prospeccion-diaria/, fuera de su
 *   autoridad — el archivo nunca llegaba. Ahora se le pide escribir en
 *   vault/1-desk/creativa-balam/marketing/prospeccion-diaria-{fecha}/correos.js
 *   y este script lo COPIA a prospeccion-diaria/{fecha}/correos.js después.
 *
 * Bug 2 (arreglado): usar registrar-tarea.js en vez de agregarTarea() directo,
 *   así la tarea SÍ aparece en panel.creativabalam.com.mx con su historial
 *   y el .md de bitácora queda enlazado.
 *
 * Bug 3 (arreglado): en vez de filtrar 4 al vuelo (y quedarse corto si
 *   alguno no tiene correo o no pasa MX), se consume del POOL YA
 *   VERIFICADO que mantiene pool-diario.js. Siempre saca 4 si el pool
 *   los tiene.
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { notificar, escaparHtml } = require('/root/agente-constructor/scripts/telegram-notify');
const { registrar } = require('/root/agente-constructor/registrar-tarea');
const Database = require('/root/ponexo-root/node_modules/better-sqlite3');

const BASE = '/root/agente-constructor/prospeccion-diaria';
const HOY = new Date().toISOString().slice(0, 10);

/**
 * Carlos vive y trabaja en Cozumel. A un prospecto de Cozumel se le puede
 * ofrecer una cita presencial (llega con el estudio impreso); a uno de
 * Bacalar, Merida o Cancun NO -- pedirle "20 minutos en tu local" cuando
 * hay que cruzar el estado suena falso y quema el correo. Fuera de Cozumel
 * se pide videollamada. Corregido el 29 agosto 2026 tras el primer lote
 * real (3 Bacalar + 1 Merida salieron pidiendo cita presencial).
 */
const ZONA_LOCAL = 'cozumel';
const DIR_HOY = path.join(BASE, HOY);
const POOL_PATH = path.join(BASE, 'pool-verificado.json');

const INICIO_EVAL = '2026-08-26';
const DIAS_APROBACION = 5;
const CUANTOS = 4;

/**
 * Toggle de procesamiento: cuando está en true, la redacción diaria se
 * manda a cola_hermes (Claude vía el poller de Hermes) en vez de
 * registrar-tarea.js (worker normal, DeepSeek). Se puede apagar volviendo
 * a false sin tocar nada más del pipeline.
 *
 * Se lee de PROCESAR_VIA_HERMES en el .env, default 'true' porque esta
 * migración es explícita (Carlos, 29 ago 2026): "necesito migrar varias
 * tareas a eso... por ahora hacer ese [marketing/prospección diaria]".
 */
const PROCESAR_VIA_HERMES = (process.env.PROCESAR_VIA_HERMES || 'true').toLowerCase() !== 'false';

function enPeriodoAprobacion() {
  const dias = Math.floor((Date.now() - new Date(INICIO_EVAL + 'T00:00:00Z')) / 86400000);
  return dias < DIAS_APROBACION;
}

(async () => {
  fs.mkdirSync(DIR_HOY, { recursive: true });

  if (!fs.existsSync(POOL_PATH)) {
    await notificar('⚠️ Prospección diaria: no existe pool-verificado.json. Correr pool-diario.js primero.');
    return;
  }
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));

  if (pool.length < CUANTOS) {
    await notificar(`⚠️ Prospección diaria ${HOY}: el pool solo tiene ${pool.length} candidatos verificados. Se necesitan ${CUANTOS}.\n\nUsa <code>/investigar</code> para autorizar más investigación.`, { html: true });
    return;
  }

  // ── Tomar 4 del pool (FIFO) y sacarlos del pool ────────────────────────
  const elegidos = pool.slice(0, CUANTOS);
  const restante = pool.slice(CUANTOS);
  fs.writeFileSync(POOL_PATH, JSON.stringify(restante, null, 2));

  // ── Pedir redacción, EN LA RUTA CORRECTA según quién procese ────────────
  // El agente marketing (worker/DeepSeek) corre en un sandbox que reescribe
  // rutas fuera de sus write_paths autorizados (bug documentado 27-28 ago:
  // agrega "-redaccion" y a veces anida otra carpeta). Cuando el poller de
  // Hermes procesa la fila, no tiene esa restricción -- puede escribir
  // directo en la ruta final del pipeline, sin necesitar recolector.
  const rutaSalida = PROCESAR_VIA_HERMES
    ? path.join(DIR_HOY, 'correos.js')
    : `vault/1-desk/creativa-balam/marketing/prospeccion-diaria-${HOY}/correos.js`;
  const PLANTILLA_ENVOLVER = `function envolver(cuerpo) {
  return \\\`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;margin:0;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e6e9">
<tr><td style="padding:34px 32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15.5px;line-height:1.65;color:#2b2b30">
\\\${cuerpo}
</td></tr>
<tr><td style="height:3px;background:#00ff9d;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="background:#050505;padding:22px 32px">
 <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;color:#e8e8ec;margin-bottom:10px">
  <span style="color:#00ff9d">&gt;</span> creativa_balam<span style="color:#00ff9d">_</span></div>
 <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#8a8a93">
  Carlos Salazar Balam &middot; Cozumel, Quintana Roo<br>
  <a href="tel:+529871123961" style="color:#22d3ee;text-decoration:none">+52 987 112 3961</a> &nbsp;&middot;&nbsp;
  <a href="mailto:carlos@creativabalam.com.mx" style="color:#22d3ee;text-decoration:none">carlos@creativabalam.com.mx</a><br>
  <a href="https://creativabalam.com.mx" style="color:#22d3ee;text-decoration:none">creativabalam.com.mx</a></div>
</td></tr></table></td></tr></table>\\\`;
}`;

  // Cierre segun donde esta cada negocio: presencial solo en Cozumel.
  const hayLocales = elegidos.some((c) => (c.zona || '').toLowerCase() === ZONA_LOCAL);
  const hayForaneos = elegidos.some((c) => (c.zona || '').toLowerCase() !== ZONA_LOCAL);
  const reglaCierre = hayLocales && hayForaneos
    ? `· EL CIERRE DEPENDE DE LA ZONA DE CADA NEGOCIO (viene marcada en la lista de abajo):
   - Negocios en Cozumel: se pide una CITA de veinte minutos EN SU LOCAL. Carlos llega con el estudio impreso Y como lo resolveria.
   - Negocios FUERA de Cozumel (Bacalar, Merida, Cancun, Tulum, Playa del Carmen, Progreso): se pide una VIDEOLLAMADA de veinte minutos. Carlos comparte pantalla con el estudio y como lo resolveria. NUNCA ofrezcas ir a su local: Carlos esta en Cozumel.`
    : hayLocales
      ? `· Se pide una CITA de veinte minutos EN SU LOCAL (estos negocios son de Cozumel, donde esta Carlos). Se lleva el estudio impreso Y como lo resolveria.`
      : `· Se pide una VIDEOLLAMADA de veinte minutos, NO una cita presencial: estos negocios estan fuera de Cozumel y Carlos vive en Cozumel. En la videollamada comparte pantalla con el estudio y como lo resolveria. NUNCA ofrezcas pasar a su local ni sugieras que estas cerca.`;

  const instrRedaccion = `Redacta ${elegidos.length} correos de prospección para Creativa Balam. NO explores el vault ni leas otras plantillas: todo lo que necesitas está aquí abajo. Ve directo a escribir el archivo.

RUTA DE SALIDA (exacta, sin variaciones — ${PROCESAR_VIA_HERMES ? 'ruta absoluta del VPS' : 'relativa a tu carpeta de escritura autorizada, vault/1-desk'}):
${rutaSalida}

PLANTILLA HTML — cópiala tal cual, no la modifiques ni la resumas:

const DE = 'Carlos Salazar Balam <carlos@creativabalam.com.mx>';

${PLANTILLA_ENVOLVER}

const p = (t) => \`<p style="margin:0 0 15px">\${t}</p>\`;
const b = (t) => \`<strong>\${t}</strong>\`;

const CORREOS = [ /* aquí van los ${elegidos.length} objetos { para, asunto, cuerpo } */ ];

module.exports = { CORREOS, DE, envolver };

REGLAS DE REDACCIÓN (no negociables, ya definidas por Carlos):
· Cada correo lleva EL DATO medido de ESE negocio (rendimiento, LCP u otro dato concreto de la lista de abajo). Nada genérico.
· Cero guiones largos (—): delatan IA.
${reglaCierre}
· Nunca decir que NO hay que rehacer el sitio ni prometer alcance sin diagnóstico.
· Si el sitio tiene algo bueno (SEO perfecto, buen diseño, reputación), dilo primero. Después el problema medido.
· Español de México, tono directo de dueño a dueño, sin tecnicismos innecesarios.
· Estos ${elegidos.length} negocios YA fueron verificados (correo alcanzable, nunca contactados, MX vivo) — no hace falta que lo revalides tú.

Negocios de hoy (usa exactamente estos datos, no busques más):
${elegidos.map((c, i) => `${i + 1}. ${c.nombre} (${c.zona}${(c.zona || '').toLowerCase() === ZONA_LOCAL ? ' — LOCAL, cita presencial' : ' — FUERA de Cozumel, videollamada'}) — ${c.rend}/100 rendimiento, LCP ${c.lcp || '?'}s — ${c.url} — correo: ${c.correo}`).join('\n')}

Al terminar, escribe SOLO el archivo correos.js en la ruta indicada. No hace falta bitácora extra ni explorar carpetas.${PROCESAR_VIA_HERMES ? `

PASO FINAL OBLIGATORIO (solo tú, el poller de Hermes, haces esto -- no es parte del archivo correos.js): en cuanto termines de escribir y verificar el archivo con node --check, corre por SSH en el VPS:
ssh -o BatchMode=yes root@169.58.63.7 "cd /root/agente-constructor && NODE_PATH=/root/agente-constructor/node_modules node prospeccion-diaria/enviar-diario.js ${enPeriodoAprobacion() ? 'revisar' : 'auto'}"
Esto dispara el aviso de borradores por Telegram (o el envío directo si ya no está en periodo de aprobación). Sin este paso el correo queda escrito pero nadie se entera.` : ''}`;

  fs.writeFileSync(path.join(DIR_HOY, 'instruccion-redaccion.txt'), instrRedaccion);
  fs.writeFileSync(path.join(DIR_HOY, 'elegidos.json'), JSON.stringify(elegidos, null, 2));

  if (PROCESAR_VIA_HERMES) {
    // Inserta directo en cola_hermes -- el poller de Hermes (cronjob cada
    // 10 min) la recoge, redacta con Claude, y actualiza panel.db al
    // terminar (mismo aparecer en el panel que antes, ver lib/programadas.ts).
    const db = new Database('/root/ponexo-root/panel.db');
    const info = db
      .prepare(
        `INSERT INTO cola_hermes (proyecto, categoria, agente, nombre_tarea, instrucciones)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('creativa-balam', 'marketing', 'marketing', `Prospección diaria ${HOY} — redacción`, instrRedaccion);
    db.close();
    console.log(`redacción encolada en cola_hermes, fila ${info.lastInsertRowid}`);
  } else {
    // registrar-tarea.js SÍ escribe en panel.db -> aparece en panel.creativabalam.com.mx
    await registrar({
      proyecto: 'creativa-balam',
      categoria: 'marketing',
      agente: 'marketing',
      nombre: `Prospección diaria ${HOY} — redacción`,
      instrucciones: instrRedaccion,
      correr: true,
    });
    console.log('redacción registrada en el panel y encolada al agente marketing (DeepSeek)');
  }

  // ── Esperar a que el agente termine, luego copiar el archivo ───────────
  // El worker es asíncrono; este orquestador solo deja programado el paso
  // de recolección. copiar-redaccion.js (corrido unos minutos después por
  // cron) mueve el archivo de vault/1-desk a prospeccion-diaria/{HOY}/.

  const resumen = elegidos.map((c, i) =>
    `${i + 1}. <b>${escaparHtml(c.nombre)}</b> (${escaparHtml(c.zona)}) ${c.rend}/100, LCP ${c.lcp || '?'}s\n   → <code>${escaparHtml(c.correo)}</code>`).join('\n');

  if (enPeriodoAprobacion()) {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'REDACTANDO');
    await notificar(
`📋 <b>Prospección diaria ${HOY}</b> — 4 elegidos del pool verificado

${resumen}

${PROCESAR_VIA_HERMES ? 'Encolado para Hermes (Claude) — el poller la recoge en su próxima pasada, máximo 10 minutos.' : 'El agente marketing está redactando (visible en el panel).'} En cuanto termine te mando los borradores completos para tu revisión.
Responde <b>manda</b> para enviarlos o <b>pasa</b> para saltarlos hoy.`,
      { html: true });
  } else {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'REDACTANDO_AUTO');
  }
})();
