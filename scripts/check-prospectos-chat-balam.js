// Revisa las conversaciones REALES del chat de creativabalam.com.mx (Dify
// self-hosted, App "Balam - Chat del sitio") en busca de visitantes que
// dejaron correo o teléfono -- Carlos preguntó el 27 julio 2026 cómo se
// entera de que hay un prospecto nuevo, y hoy nada lo avisaba (el /api/chat
// del sitio es solo un proxy hacia Dify, no guarda ni notifica nada del
// lado del sitio).
//
// Consulta la base de Postgres de Dify DIRECTO (vía `docker exec` a
// docker-db_postgres-1, misma VPS) en vez de la API de servicio, porque esa
// API solo lista conversaciones de UN `user` a la vez -- no hay forma de
// pedirle "todas las conversaciones de la App" sin saber de antemano cada
// visitorId, que solo vive en el localStorage del navegador de cada quien.
// Todo de solo lectura (SELECT), nunca escribe en la base de Dify.
//
// Solo notifica por Telegram si detecta un correo o teléfono en los
// mensajes del VISITANTE (nunca en las respuestas del bot -- el bot mismo
// recita el teléfono de Balam, eso no cuenta como "el prospecto dejó
// contacto"). Pedido explícito de Carlos: "solo si deja algún tipo de
// contacto", con un resumen condensado al inicio del mismo doc que la
// conversación completa.
//
// Uso: node scripts/check-prospectos-chat-balam.js
// Requiere en .env: DEEPSEEK_API_KEY (resumen), TELEGRAM_BOT_TOKEN/
// TELEGRAM_CHAT_ID (aviso, opcional -- se degrada sin romper nada).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { notificar } = require('./telegram-notify');

const APP_ID = 'e4efff0e-bfa9-4c99-858c-fac49775ae64'; // "Balam - Chat del sitio"
// end_user de la auditoría sintética diaria (dify-chat-check.js) -- sus
// preguntas de prueba no son un prospecto real, se excluyen de raíz.
const AUDIT_END_USER_ID = 'fd6a1879-d913-450c-ad83-8e0d097fa111';
const LOOKBACK_DIAS = 30;

const OUT_DIR = path.join(__dirname, '..', 'vault', '5-bot-logs', 'balam-website', 'prospectos');
const STATE_FILE = path.join(OUT_DIR, '.state.json');
const FILEBROWSER_URL = 'https://archivos.creativabalam.com.mx/files/bots/balam-website/prospectos';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function posiblesTelefonos(texto) {
  const candidatos = texto.match(/[\d\s().-]{10,}/g) || [];
  return candidatos
    .map((s) => s.replace(/[^\d]/g, ''))
    .filter((d) => d.length >= 10 && d.length <= 13);
}

function quitarThink(texto) {
  // Mismo bug ya conocido del frontend (ver chat-widget.tsx del sitio): el
  // modelo de razonamiento a veces deja <think>...</think> crudo en la
  // respuesta guardada en la base -- se limpia también aquí para el doc.
  return String(texto || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function consultarDify(sql) {
  const salida = execFileSync(
    'docker',
    ['exec', 'docker-db_postgres-1', 'psql', '-U', 'postgres', '-d', 'dify', '-t', '-A', '-c', sql],
    { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 },
  );
  return JSON.parse(salida.trim() || '[]');
}

// FileBrowser corre como uid 1000 (ubuntu) -- un archivo creado por este
// script mientras corre como root (systemd, User=root, igual que el resto
// de los crons de este proyecto) queda root-owned y FileBrowser no puede
// escribirlo/editarlo después, mismo bug real ya documentado y corregido
// una vez en vault/estado-proyectos/_sistema.md para otras carpetas. Se
// corrige aquí de raíz en vez de depender de que nadie vuelva a crear
// archivos como root en /archivos.
function asegurarPropietarioUbuntu(rutaAbs) {
  try {
    fs.chownSync(rutaAbs, 1000, 1000);
  } catch {
    // No es root o uid 1000 no existe en este entorno -- nada que hacer.
  }
}

function cargarEstado() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { notificados: [] };
  }
}

function guardarEstado(estado) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  asegurarPropietarioUbuntu(OUT_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2), 'utf-8');
  asegurarPropietarioUbuntu(STATE_FILE);
}

async function generarResumen(transcript) {
  try {
    const respuesta = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        // deepseek-v4-flash es un modelo de razonamiento: max_tokens se
        // reparte entre reasoning_content y el content visible -- con un
        // límite corto (300) el razonamiento a veces se come todo el
        // presupuesto y deja content vacío (visto en vivo con una
        // conversación real de varios turnos). 1000 da margen de sobra
        // para un resumen de 2-4 oraciones sin acercarse a costos altos.
        max_tokens: 1000,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'Resume en español, en 2-4 oraciones, qué necesita este visitante del chat de ' +
              'Creativa Balam (estudio de software) y qué se entiende que busca. Sé concreto, ' +
              'sin relleno, sin repetir literalmente el contacto (eso ya se muestra aparte).',
          },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!respuesta.ok) throw new Error(`DeepSeek ${respuesta.status}: ${await respuesta.text()}`);
    const json = await respuesta.json();
    const mensaje = json.choices?.[0]?.message;
    // Si content viene vacío (razonamiento se comió el presupuesto pese al
    // margen de arriba), reasoning_content suele traer igual la idea
    // completa -- mejor eso que un resumen en blanco.
    return mensaje?.content?.trim() || mensaje?.reasoning_content?.trim() || '(resumen vacío)';
  } catch (err) {
    console.warn(`No se pudo generar el resumen: ${err.message}`);
    return '(no se pudo generar el resumen automático -- ver la conversación completa abajo)';
  }
}

async function main() {
  const filas = consultarDify(
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
      `SELECT conversation_id, query, answer, created_at FROM messages ` +
      `WHERE app_id = '${APP_ID}' AND from_end_user_id != '${AUDIT_END_USER_ID}' ` +
      `AND created_at > now() - interval '${LOOKBACK_DIAS} days' ` +
      `ORDER BY conversation_id, created_at` +
      `) t`,
  );

  const conversaciones = new Map();
  for (const fila of filas) {
    if (!conversaciones.has(fila.conversation_id)) conversaciones.set(fila.conversation_id, []);
    conversaciones.get(fila.conversation_id).push(fila);
  }

  const estado = cargarEstado();
  const yaNotificados = new Set(estado.notificados);
  let nuevos = 0;

  for (const [conversationId, mensajes] of conversaciones) {
    if (yaNotificados.has(conversationId)) continue;

    const textoVisitante = mensajes.map((m) => m.query).join('\n');
    const correo = textoVisitante.match(EMAIL_RE)?.[0];
    const telefonos = posiblesTelefonos(textoVisitante);
    if (!correo && telefonos.length === 0) continue;

    const transcript = mensajes
      .map((m) => `Visitante: ${m.query}\nBalam: ${quitarThink(m.answer)}`)
      .join('\n\n');

    console.log(`📩 Prospecto nuevo detectado (conversación ${conversationId.slice(0, 8)}...)`);
    const resumen = await generarResumen(transcript);

    const fecha = mensajes[mensajes.length - 1].created_at.slice(0, 10);
    const nombreArchivo = `${fecha}-${conversationId.slice(0, 8)}.md`;
    const contenido = `# Prospecto detectado — ${fecha}

## Resumen
${resumen}

## Contacto detectado
${correo ? `- Correo: ${correo}\n` : ''}${telefonos.length ? `- Posible(s) teléfono(s): ${telefonos.join(', ')}\n` : ''}
---

## Conversación completa

${transcript}
`;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    asegurarPropietarioUbuntu(OUT_DIR);
    const rutaArchivo = path.join(OUT_DIR, nombreArchivo);
    fs.writeFileSync(rutaArchivo, contenido, 'utf-8');
    asegurarPropietarioUbuntu(rutaArchivo);

    yaNotificados.add(conversationId);
    nuevos++;

    await notificar(
      `📩 Prospecto nuevo en el chat de Balam\n\n${resumen}\n\n` +
        `${correo ? `Correo: ${correo}\n` : ''}${telefonos.length ? `Tel: ${telefonos.join(', ')}\n` : ''}\n` +
        `${FILEBROWSER_URL}/${nombreArchivo}`,
    );
  }

  guardarEstado({ notificados: [...yaNotificados] });
  console.log(
    nuevos > 0
      ? `✅ ${nuevos} prospecto(s) nuevo(s) con contacto, notificado(s) por Telegram.`
      : `Sin prospectos nuevos con contacto (${conversaciones.size} conversación(es) revisada(s) en total).`,
  );
}

main().catch((err) => {
  console.error('Fallo revisando prospectos del chat:', err.message);
  process.exit(1);
});
