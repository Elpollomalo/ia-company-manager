#!/usr/bin/env node
/**
 * ¿EXISTE EL BUZÓN? — verificación SMTP antes de gastar un envío.
 *
 * Por qué existe (3 noviembre 2026):
 * `info@spanishschools.com.mx` rebotó con 550 5.1.1 "Email address could not
 * be found, or was misspelled". El correo estaba publicado en su propio sitio,
 * el dominio tenía MX válido (Rackspace) y aun así el buzón no existía. El MX
 * sólo dice que el dominio recibe correo: no dice si esa cuenta en particular
 * vive ahí. Ese hueco lo cerró el rebote, y un rebote castiga la reputación del
 * dominio remitente, no la del destinatario.
 *
 * Qué hace: habla SMTP con el MX real y pregunta por el buzón con RCPT TO, sin
 * mandar el mensaje. Si el servidor contesta 550/551/553/554 el buzón no
 * existe y ese correo no se manda. Si contesta 4xx es temporal (buzón lleno,
 * greylisting): no se descarta, se reintenta otro día. Si no hubo respuesta
 * (timeout, red, bloqueo) queda en 'desconocido' y tampoco se descarta: no
 * saber no es lo mismo que saber que no existe.
 *
 * Límite honesto: muchos servidores aceptan cualquier RCPT (catch-all) o
 * responden 250 a todo para no delatar sus buzones. Contra esos, esto no
 * protege; sólo el rebote real lo dice. Por eso el registro de rebotes
 * (sincronizar-estados-resend.js) sigue siendo la otra mitad del control.
 *
 * Cache: buzones.json, para no repetir la conversación SMTP en cada corrida.
 * Un 'valido' se revisa cada 30 días, un 'inexistente' cada 60.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CACHE_PATH = path.join(__dirname, '..', 'buzones.json');
const REMITENTE = 'carlos@creativabalam.com.mx';
const HELO = 'creativabalam.com.mx';
const DIAS = { valido: 30, inexistente: 60, temporal: 2, desconocido: 2, sin_mx: 30 };

function leerCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function guardarCache(c) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); } catch {}
}

/** MX del dominio, o el A si el dominio recibe correo sin MX (RFC 5321). */
function mxDe(dominio) {
  try {
    const mx = execSync(`dig +short MX ${dominio} @8.8.8.8`, { timeout: 8000 }).toString().trim()
      .split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean);
    if (mx.length) return mx[0];
    const a = execSync(`dig +short A ${dominio} @8.8.8.8`, { timeout: 5000 }).toString().trim().split('\n')[0];
    return a || null;
  } catch { return null; }
}

/** Conversación mínima: saludo -> HELO -> MAIL FROM -> RCPT TO. Devuelve el código del RCPT. */
function preguntarBuzon(host, correo, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let buf = '';
    let paso = 0;
    let cerrado = false;
    let sock;
    let timer;

    const fin = (r) => {
      if (cerrado) return;
      cerrado = true;
      clearTimeout(timer);
      try { sock.write('QUIT\r\n'); } catch {}
      try { sock.destroy(); } catch {}
      resolve(r);
    };

    try { sock = net.createConnection({ host, port: 25 }); }
    catch (e) { return resolve({ codigo: 0, texto: 'sin conexión: ' + e.message }); }

    timer = setTimeout(() => fin({ codigo: 0, texto: 'timeout' }), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (e) => fin({ codigo: 0, texto: e.code || e.message }));
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const linea = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (/^\d{3}-/.test(linea)) continue; // respuesta multilínea: falta el final
        const m = linea.match(/^(\d{3})\s?(.*)$/);
        if (!m) continue;
        const codigo = parseInt(m[1], 10);
        const texto = (m[2] || '').trim();
        if (paso === 0) {
          if (codigo !== 220) return fin({ codigo, texto: 'saludo: ' + texto });
          paso = 1; sock.write(`HELO ${HELO}\r\n`);
        } else if (paso === 1) {
          if (codigo >= 400) return fin({ codigo, texto: 'helo: ' + texto });
          paso = 2; sock.write(`MAIL FROM:<${REMITENTE}>\r\n`);
        } else if (paso === 2) {
          if (codigo >= 400) return fin({ codigo, texto: 'mail from: ' + texto });
          paso = 3; sock.write(`RCPT TO:<${correo}>\r\n`);
        } else {
          return fin({ codigo, texto });
        }
      }
    });
  });
}

function interpretar({ codigo, texto }) {
  if (codigo === 250 || codigo === 251) return { estado: 'valido', motivo: `${codigo} ${texto}` };
  if ([550, 551, 553, 554].includes(codigo)) return { estado: 'inexistente', motivo: `${codigo} ${texto}` };
  if ([421, 450, 451, 452].includes(codigo)) return { estado: 'temporal', motivo: `${codigo} ${texto}` };
  if (codigo === 0) return { estado: 'desconocido', motivo: texto };
  return { estado: 'desconocido', motivo: `${codigo} ${texto}` };
}

function fresco(registro) {
  if (!registro || !registro.fecha) return false;
  const dias = DIAS[registro.estado] ?? 7;
  const edad = (Date.now() - new Date(registro.fecha).getTime()) / 86400000;
  return edad < dias;
}

/**
 * @param {string} correo
 * @param {{forzar?: boolean}} opts
 * @returns {Promise<{correo:string,estado:string,motivo:string,fecha:string,mx:string|null,deCache:boolean}>}
 */
async function verificarBuzon(correo, opts = {}) {
  const dir = String(correo || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(dir)) {
    return { correo: dir, estado: 'inexistente', motivo: 'dirección malformada', fecha: new Date().toISOString(), mx: null, deCache: false };
  }

  const cache = leerCache();
  if (!opts.forzar && fresco(cache[dir])) return { ...cache[dir], deCache: true };

  const dominio = dir.split('@')[1];
  const mx = mxDe(dominio);
  let resultado;
  if (!mx) {
    resultado = { correo: dir, estado: 'sin_mx', motivo: 'el dominio no tiene MX', mx: null };
  } else {
    const r = await preguntarBuzon(mx, dir);
    resultado = { correo: dir, ...interpretar(r), mx };
  }

  const registro = { ...resultado, fecha: new Date().toISOString() };
  cache[dir] = registro;
  guardarCache(cache);
  return { ...registro, deCache: false };
}

module.exports = { verificarBuzon, mxDe };

// CLI: node lib/verificar-buzon.js correo1 correo2 ...
if (require.main === module) {
  (async () => {
    const lista = process.argv.slice(2);
    if (!lista.length) { console.log('Uso: node lib/verificar-buzon.js correo@dominio.com [...]'); process.exit(0); }
    for (const c of lista) {
      const r = await verificarBuzon(c);
      console.log(`${r.estado.padEnd(12)} ${r.correo}  ${r.mx || '-'}  ${r.motivo}${r.deCache ? '  (cache)' : ''}`);
    }
  })();
}
