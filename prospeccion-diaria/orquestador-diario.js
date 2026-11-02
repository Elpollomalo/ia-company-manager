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

// No mandar correos sábado ni domingo — las oficinas no trabajan y no los leen.
// --dry-run se salta esta regla a propósito: sirve justo para revisar en fin de
// semana qué se mandaría el lunes, sin escribir ni encolar nada.
const diaHoy = new Date().getDay(); // 0=domingo, 6=sábado
if ((diaHoy === 0 || diaHoy === 6) && !process.argv.includes('--dry-run')) {
  console.log(`Hoy es ${diaHoy === 0 ? 'domingo' : 'sábado'}, no se mandan correos de prospección.`);
  process.exit(0);
}
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
const CUANTOS = 5;

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

/**
 * elegirMezclados(pool, n) — saca n candidatos del pool, mezclando tipos.
 *
 * 1. Agrupa por tipo_campana (candidatos sin tipo se tratan como 'sitio_lento').
 * 2. Round-robin: saca 1 de cada tipo disponible, repite hasta completar n.
 * 3. Retorna los elegidos en orden de selección.
 */
function elegirMezclados(pool, n) {
  // Agrupar por tipo_campana
  const grupos = {};
  for (const c of pool) {
    const tipo = c.tipo_campana || 'sitio_lento';
    if (!grupos[tipo]) grupos[tipo] = [];
    grupos[tipo].push(c);
  }

  const tipos = Object.keys(grupos);
  const elegidos = [];
  let ronda = 0;

  while (elegidos.length < n && tipos.length > 0) {
    const tiposVivos = tipos.filter((t) => grupos[t].length > ronda);
    if (tiposVivos.length === 0) break;
    for (const tipo of tiposVivos) {
      if (elegidos.length >= n) break;
      elegidos.push(grupos[tipo][ronda]);
    }
    ronda++;
  }

  return elegidos;
}

/**
 * Reglas de redacción específicas por tipo de campaña (sección 6 de arquitectura-campanas-v2.md).
 */
const REGLAS_POR_TIPO = {
  sitio_lento: `REGLAS TIPO sitio_lento:
- Abrir con el dato de rendimiento/LCP.
- Si el diseño es bueno, reconocerlo antes de hablar de velocidad.
- Ofrecer: "te muestro qué está frenando tu sitio y cómo se arregla".
- Nunca decir "hay que rehacer el sitio" ni "es fácil de corregir".
- Carlos lleva el estudio impreso (o comparte pantalla si es videollamada).
- SERVICIO A OFRECER: optimización web o desarrollo nuevo.`,

  invisible_google: `REGLAS TIPO invisible_google:
- Abrir con: "busqué '{búsqueda}' y no sales en los primeros resultados".
- Mencionar quién SÍ sale (top 3 competidores) para que sea tangible.
- NO hablar de PageSpeed ni de velocidad: este correo es sobre visibilidad.
- Ofrecer: "te muestro exactamente por qué no apareces y qué hay que hacer para que cuando alguien busque {giro} en {zona}, te encuentre".
- Tono: no es un regaño, es una oportunidad perdida. "Cada día que no sales, esas búsquedas se las lleva tu competencia".
- SERVICIO A OFRECER: posicionamiento en Google (SEO).`,

  sin_ads: `REGLAS TIPO sin_ads:
- Abrir con: "tu competidor {nombre} está invirtiendo en Google Ads para '{búsqueda}' y tú no".
- Ser específico: nombrar al competidor y la búsqueda exacta.
- NO hablar de SEO ni velocidad: este correo es sobre publicidad pagada.
- Ofrecer: "te muestro cuánto invierte tu competencia y cómo puedes aparecer tú también con un presupuesto controlado".
- Tono: urgencia competitiva. "Cada clic que se lleva tu competidor es un cliente que no te ve".
- SERVICIO A OFRECER: gestión Google/Meta Ads.`,

  sin_sitio: `REGLAS TIPO sin_sitio:
- Abrir con: "busqué '{giro} {zona}' y tu competencia (X, Y) ya tiene presencia digital, tú todavía no".
- No ser condescendiente. No asumir que no quieren sitio.
- Ofrecer: "te muestro cómo sería tu sitio y qué te traería en clientes nuevos".
- Dato concreto: mencionar competidores específicos que SÍ tienen sitio.
- Tono: invitación, no lección. "Hoy la gente busca en Google antes de ir a cualquier lado".
- SERVICIO A OFRECER: desarrollo web.`,
};

/**
 * Arma la ficha descriptiva de un candidato para la instrucción de redacción,
 * incluyendo tipo de campaña, dato_duro, y reglas específicas.
 */
function fichaCandiato(c, i) {
  const tipo = c.tipo_campana || 'sitio_lento';
  const esLocal = (c.zona || '').toLowerCase() === ZONA_LOCAL;
  const modalidad = esLocal ? 'LOCAL, cita presencial' : 'FUERA de Cozumel, videollamada';

  // Dato duro: usar campo explícito o construir desde rend/lcp (compat v1)
  const datoDuro = c.dato_duro
    || `tu sitio tiene ${c.rend || '?'}/100 de rendimiento y carga en ${c.lcp || '?'}s`;

  // Contexto extra (si existe)
  const ctx = c.contexto_extra || {};
  const lineasCtx = [];
  if (ctx.top_3) lineasCtx.push(`Competidores que SÍ salen: ${ctx.top_3.join(', ')}`);
  if (ctx.busqueda) lineasCtx.push(`Búsqueda: "${ctx.busqueda}"`);
  if (ctx.competidor_con_ads) lineasCtx.push(`Competidor con ads: ${ctx.competidor_con_ads} (${ctx.competidor_dominio || ''})`);
  if (ctx.competidores_con_sitio) lineasCtx.push(`Competidores con sitio: ${ctx.competidores_con_sitio.join(', ')}`);

  let ficha = `${i + 1}. ${c.nombre} (${c.zona} — ${modalidad})
   TIPO: ${tipo}
   DATO DURO: ${datoDuro}
   URL: ${c.url || '(sin sitio)'}
   CORREO: ${c.correo}`;

  if (lineasCtx.length > 0) {
    ficha += `\n   CONTEXTO: ${lineasCtx.join('. ')}`;
  }

  return ficha;
}

(async () => {
  fs.mkdirSync(DIR_HOY, { recursive: true });

  // --dry-run: muestra qué elegiría y con qué se quedaría el pool, sin
  // tocar nada ni encolar redacción. Sirve para verificar en domingo o antes
  // de cambiar la mezcla de tipos sin riesgo de mandar correos.
  const DRY_RUN = process.argv.includes('--dry-run');

  if (!fs.existsSync(POOL_PATH)) {
    await notificar('⚠️ Prospección diaria: no existe pool-verificado.json. Correr pool-diario.js primero.');
    return;
  }
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));

  if (pool.length < CUANTOS) {
    await notificar(`⚠️ Prospección diaria ${HOY}: el pool solo tiene ${pool.length} candidatos verificados. Se necesitan ${CUANTOS}.\n\nUsa <code>/investigar</code> para autorizar más investigación.`, { html: true });
    return;
  }

  // ── Tomar N del pool (mezclando tipos) y sacarlos del pool ──────────────
  const elegidos = elegirMezclados(pool, CUANTOS);

  if (DRY_RUN) {
    const porTipo = elegidos.reduce((acc, c) => {
      const t = c.tipo_campana || 'sitio_lento';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});
    const porZona = elegidos.reduce((acc, c) => {
      const z = c.zona || 'desconocida';
      acc[z] = (acc[z] || 0) + 1;
      return acc;
    }, {});
    console.log(`[dry-run] ${HOY}: elegiría ${elegidos.length} de ${pool.length} en el pool`);
    console.log('[dry-run] por tipo:', porTipo);
    console.log('[dry-run] por zona:', porZona);
    for (const c of elegidos) {
      console.log(`  - ${c.nombre} | ${c.tipo_campana || 'sitio_lento'} | ${c.zona || '?'} | ${c.correo}`);
    }
    console.log('[dry-run] no se escribió nada ni se encoló redacción.');
    return;
  }

  const elegidosSet = new Set(elegidos.map((c) => c.correo || c.dominio || c.nombre));
  const restante = pool.filter((c) => !elegidosSet.has(c.correo || c.dominio || c.nombre));
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

  // Recoger los tipos presentes en el lote para incluir reglas específicas
  const tiposPresentes = [...new Set(elegidos.map((c) => c.tipo_campana || 'sitio_lento'))];
  const reglasEspecificas = tiposPresentes
    .map((t) => REGLAS_POR_TIPO[t] || `REGLAS TIPO ${t}: (sin reglas específicas definidas, usar las generales)`)
    .join('\n\n');

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

REGLAS DE REDACCIÓN GENERALES (no negociables, ya definidas por Carlos):
· Cada correo lleva EL DATO medido de ESE negocio (el "dato duro" que viene en la ficha de abajo). Nada genérico.
· Cero guiones largos (—): delatan IA.
${reglaCierre}
· Nunca decir que NO hay que rehacer el sitio ni prometer alcance sin diagnóstico.
· Si el sitio tiene algo bueno (SEO perfecto, buen diseño, reputación), dilo primero. Después el problema medido.
· Español de México, tono directo de dueño a dueño, sin tecnicismos innecesarios.
· Estos ${elegidos.length} negocios YA fueron verificados (correo alcanzable, nunca contactados, MX vivo) — no hace falta que lo revalides tú.

REGLAS ESPECÍFICAS POR TIPO DE CAMPAÑA (cada correo sigue las reglas de SU tipo):

${reglasEspecificas}

Negocios de hoy (usa exactamente estos datos, no busques más):
${elegidos.map((c, i) => fichaCandiato(c, i)).join('\n---\n')}

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

  const resumen = elegidos.map((c, i) => {
    const tipo = c.tipo_campana || 'sitio_lento';
    const datoDuroCorto = c.dato_duro
      ? c.dato_duro.slice(0, 60) + (c.dato_duro.length > 60 ? '...' : '')
      : `${c.rend || '?'}/100, LCP ${c.lcp || '?'}s`;
    return `${i + 1}. <b>${escaparHtml(c.nombre)}</b> (${escaparHtml(c.zona)}) [${tipo}]\n   ${escaparHtml(datoDuroCorto)}\n   → <code>${escaparHtml(c.correo)}</code>`;
  }).join('\n');

  if (enPeriodoAprobacion()) {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'REDACTANDO');
    await notificar(
`📋 <b>Prospección diaria ${HOY}</b> — ${elegidos.length} elegidos del pool verificado

${resumen}

${PROCESAR_VIA_HERMES ? 'Encolado para Hermes (Claude) — el poller la recoge en su próxima pasada, máximo 10 minutos.' : 'El agente marketing está redactando (visible en el panel).'} En cuanto termine te mando los borradores completos para tu revisión.
Responde <b>manda</b> para enviarlos o <b>pasa</b> para saltarlos hoy.`,
      { html: true });
  } else {
    fs.writeFileSync(path.join(DIR_HOY, 'estado.txt'), 'REDACTANDO_AUTO');
  }
})().then(
  () => process.stdout.write('', () => process.exit(0)),
  (err) => { console.error('[error fatal]', err); process.stdout.write('', () => process.exit(1)); }
);
