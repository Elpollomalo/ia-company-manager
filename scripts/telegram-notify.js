// Notificaciones de sistema por Telegram — bot t.me/Ia_company_bot (creado 26 julio 2026).
// Uso: const { notificar } = require('./telegram-notify'); await notificar('texto');
//
// Se degrada sin romper nada si TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID no están
// configurados, y nunca lanza (un error de red al notificar no debe tumbar
// la tarea real que sí terminó bien o mal).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * @param {string} mensaje
 * @param {{html?: boolean}} [opciones] `html: true` interpreta <a>, <b> y <code>.
 *
 * Por qué existe el modo HTML (4 agosto 2026): en texto plano Telegram decide
 * solo qué convierte en liga, y se equivoca. Un nombre de archivo como
 * `prueba-aviso.md` lo volvía la liga `http://prueba-aviso.md` — `.md` es el
 * dominio de Moldavia — y al tocarlo daba error de DNS. Carlos: *"el archivo
 * no lleva a ningún doc"*. En HTML sólo es liga lo que se marca como tal.
 *
 * Ojo al usarlo: el texto que venga de fuera (nombres de tarea, errores) tiene
 * que pasar por `escaparHtml`, o un `<` cualquiera tumba el mensaje entero.
 */
async function notificar(mensaje, opciones = {}) {
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
            body: JSON.stringify({
                chat_id: chatId,
                text: mensaje,
                ...(opciones.html ? { parse_mode: 'HTML' } : {}),
            }),
        });
        if (!respuesta.ok) {
            console.warn(`[telegram-notify] Telegram respondió ${respuesta.status}: ${await respuesta.text()}`);
        }
    } catch (err) {
        console.warn(`[telegram-notify] No se pudo notificar: ${err.message}`);
    }
}

/** Para meter texto ajeno dentro de un mensaje con `html: true`. */
function escaparHtml(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = { notificar, escaparHtml };
