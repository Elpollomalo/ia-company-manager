// Notificaciones de sistema por Telegram — bot t.me/Ia_company_bot (creado 26 julio 2026).
// Uso: const { notificar } = require('./telegram-notify'); await notificar('texto');
//
// Se degrada sin romper nada si TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID no están
// configurados, y nunca lanza (un error de red al notificar no debe tumbar
// la tarea real que sí terminó bien o mal).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function notificar(mensaje) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('[telegram-notify] Falta TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — se omite la notificación.');
        return;
    }
    try {
        const respuesta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: mensaje }),
        });
        if (!respuesta.ok) {
            console.warn(`[telegram-notify] Telegram respondió ${respuesta.status}: ${await respuesta.text()}`);
        }
    } catch (err) {
        console.warn(`[telegram-notify] No se pudo notificar: ${err.message}`);
    }
}

module.exports = { notificar };
