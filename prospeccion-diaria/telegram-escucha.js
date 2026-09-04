#!/usr/bin/env node
/**
 * ESCUCHA DE TELEGRAM — respuestas de Carlos al flujo de prospección diaria.
 *
 * Corre como servicio (systemd). Cada 15 s consulta getUpdates del bot y
 * reacciona a los comandos del flujo:
 *
 *   /investigar <zona o tema>   -> autoriza una investigación nueva
 *                                  (la encola al agente que corresponda)
 *   manda                       -> aprueba los borradores de hoy (enviar-diario.js aprobar)
 *   pasa                        -> descarta los borradores de hoy
 *   /estado                     -> resumen rápido del día
 *
 * Todo lo demás se ignora en silencio (el bot ya tiene otros usos).
 */
require('dotenv').config({ path: '/root/agente-constructor/.env' });
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { notificar, escaparHtml } = require('/root/agente-constructor/scripts/telegram-notify');
const { agregarTarea } = require('/root/agente-constructor/queue');

const OFFSET_PATH = '/root/agente-constructor/prospeccion-diaria/.tg-offset';
const BASE = '/root/agente-constructor/prospeccion-diaria';

function offset() { try { return parseInt(fs.readFileSync(OFFSET_PATH, 'utf8').trim()); } catch { return 0; } }
function guardarOffset(o) { fs.writeFileSync(OFFSET_PATH, String(o)); }

async function api(metodo, params) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${metodo}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

function hoy() {
  const d = new Date().toISOString().slice(0, 10);
  return { hoy: d, dir: path.join(BASE, d) };
}

async function procesar(msg) {
  const texto = (msg.text || '').trim();
  const chatId = String(msg.chat?.id || '');
  const chatConfig = String(process.env.TELEGRAM_CHAT_ID);
  // Solo acepta comandos del chat configurado
  if (!chatId || chatId !== chatConfig) return;

  const lower = texto.toLowerCase();

  if (lower === 'manda') {
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/enviar-diario.js', 'aprobar'],
      { timeout: 1000 * 60 * 20 }, (err) => { if (err) notificar(`⚠️ Error al enviar: ${err.message}`); });
    await notificar('🚀 Enviando lote de hoy...');
  } else if (lower === 'pasa') {
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/enviar-diario.js', 'pasar']);
    await notificar('↩️ Borradores de hoy descartados.');
  } else if (lower.startsWith('/investigar ')) {
    const tema = texto.slice('/investigar '.length).trim();
    const tarea = `Investigación autorizada por Carlos por Telegram el ${new Date().toISOString()}. Tema: ${tema}. Guarda el informe en vault/7-investigacion-mercado/creativa-balam/ siguiendo el formato de los informes anteriores.`;
    const { viaHermes } = await agregarTarea('investigadores', 'creativa-balam', tarea, { nombreTarea: `Investigación: ${tema.slice(0, 60)}` });
    await notificar(
      viaHermes
        ? `🔬 Investigación encolada para Hermes (Claude).\nTema: <i>${escaparHtml(tema)}</i>\nEl poller la recoge en su próxima pasada, máximo 10 minutos.`
        : `🔬 Investigación encolada al agente investigadores.\nTema: <i>${escaparHtml(tema)}</i>\nQuedará registrada en el panel.`,
      { html: true });
  } else if (lower.startsWith('/cerrado ')) {
    // /cerrado correo@dominio.com 12000 nota opcional aqui
    const partes = texto.slice('/cerrado '.length).trim().split(' ');
    const correo = partes[0];
    const monto = partes[1];
    const nota = partes.slice(2).join(' ') || null;
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/seguimiento.js', 'marcar', correo, 'cerrado_ganado', '--monto', monto || '0', ...(nota ? ['--nota', nota] : [])],
      (err, stdout) => { notificar(err ? `⚠️ ${err.message}` : `🎉 ${stdout.trim()}`); });
  } else if (lower.startsWith('/respondio ')) {
    const correo = texto.slice('/respondio '.length).trim();
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/seguimiento.js', 'marcar', correo, 'respondio'],
      (err, stdout) => { notificar(err ? `⚠️ ${err.message}` : `💬 ${stdout.trim()}`); });
  } else if (lower.startsWith('/cita ')) {
    const correo = texto.slice('/cita '.length).trim();
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/seguimiento.js', 'marcar', correo, 'cita_agendada'],
      (err, stdout) => { notificar(err ? `⚠️ ${err.message}` : `📅 ${stdout.trim()}`); });
  } else if (lower.startsWith('/perdido ')) {
    const partes = texto.slice('/perdido '.length).trim().split(' ');
    const correo = partes[0];
    const nota = partes.slice(1).join(' ') || null;
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/seguimiento.js', 'marcar', correo, 'cerrado_perdido', ...(nota ? ['--nota', nota] : [])],
      (err, stdout) => { notificar(err ? `⚠️ ${err.message}` : `❌ ${stdout.trim()}`); });
  } else if (lower === '/embudo' || lower === '/estadisticas') {
    execFile('node', ['/root/agente-constructor/prospeccion-diaria/seguimiento.js', 'estadisticas'],
      (err, stdout) => { notificar(err ? `⚠️ ${err.message}` : `<pre>${escaparHtml(stdout.trim())}</pre>`, { html: true }); });
  } else if (lower === '/estado') {
    const { hoy: h, dir } = hoy();
    const estado = fs.existsSync(path.join(dir, 'estado.txt'))
      ? fs.readFileSync(path.join(dir, 'estado.txt'), 'utf8') : 'sin corrida hoy';
    let log = '';
    const logPath = path.join(dir, 'enviados.log');
    if (fs.existsSync(logPath)) log = '\n\n' + fs.readFileSync(logPath, 'utf8').split('\n').slice(-8).join('\n');
    await notificar(`📊 <b>Prospección ${h}</b>\nEstado: <code>${escaparHtml(estado)}</code>${escaparHtml(log)}`, { html: true });
  }
}

(async () => {
  await notificar('👂 Escucha de Telegram iniciada (prospección diaria).');
  for (;;) {
    try {
      const j = await api('getUpdates', { timeout: 30, offset: offset() + 1, allowed_updates: ['message'] });
      if (j.ok && Array.isArray(j.result)) {
        for (const u of j.result) {
          guardarOffset(u.update_id);
          if (u.message) await procesar(u.message);
        }
      }
    } catch (e) {
      console.error(new Date().toISOString(), e.message);
      await new Promise(r => setTimeout(r, 15000));
    }
  }
})();
