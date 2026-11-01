/**
 * Utilidades compartidas para leer los informes markdown del vault y sacar
 * negocios de ahí sin confundir una nota con un nombre.
 *
 * ── Por qué existe (8 octubre 2026) ───────────────────────────────────────
 * Tanto pool-diario.js como detector-seo.js asumían que en toda tabla
 * markdown la PRIMERA columna es el nombre del negocio. En los informes del
 * agente `investigadores` varias tablas empiezan con una columna de notas
 * ("Tipo de sitio", "Estado", etc.), así que entraron al pool cosas como
 * "Con sitio web propio (visitados)" y "De Sección Amarilla (solo
 * directorio)". Dos correos salieron con esas frases como si fueran el
 * nombre del negocio.
 *
 * Ahora el nombre, la URL y el correo se localizan por el ENCABEZADO de la
 * tabla, no por posición. Y cualquier candidato cuyo "nombre" parezca una
 * nota se descarta en vez de llegar al pool.
 */

/** Índice de la primera columna cuyo encabezado cumpla el patrón, o -1. */
function indiceColumna(encabezados, patron) {
  for (let i = 0; i < encabezados.length; i++) {
    if (patron.test(encabezados[i])) return i;
  }
  return -1;
}

/**
 * ¿Este texto parece un nombre de negocio de verdad?
 * Descarta notas de tabla, descripciones y frases con verbo.
 */
function esNombreValido(nombre) {
  if (!nombre) return false;
  const n = nombre.trim();
  if (n.length < 2 || n.length > 70) return false;

  // Frases que delatan una nota o descripción, no un nombre.
  // Ojo: NO se rechaza por empezar con artículo ("La Casita de Indio",
  // "El Chile Habanero" y "Los Cinco Soles" son negocios reales).
  const empiezaComoNota = /^(con|sin|tienen|tiene|ofrecen|ofrece|no\s|solo\s|únicamente|unicamente|cuenta con|parece|está|esta)\b/i;
  if (empiezaComoNota.test(n)) return false;

  // Paréntesis explicativos al final: "(visitados)", "(solo directorio)"
  if (/\((?:[^)]{0,40})\)\s*$/.test(n) && !/[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ]/.test(n)) return false;

  // Verbos y conectores de descripción
  if (/,\s*(pero|aunque|sin|con)\b/i.test(n)) return false;
  if (/\b(pero|aunque|visitados|visitado|directorio|no los encuentran|no aparece|no aparecen|tarda \d|segundos)\b/i.test(n)) return false;

  // Demasiadas palabras => descripción, no nombre
  if (n.split(/\s+/).length > 8) return false;

  // Tiene que traer al menos una letra
  if (!/[a-zA-ZÁÉÍÓÚÑáéíóúñ]/.test(n)) return false;

  return true;
}

/** Limpia marcas de markdown de una celda. */
function limpiarCelda(celda) {
  return (celda || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [texto](url) -> texto
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Saca el dominio de una celda que puede traer [texto](url), URL o dominio pelón. */
function dominioDeCelda(celda) {
  const limpio = limpiarCelda(celda);
  if (!limpio) return null;
  const enlace = (celda || '').match(/\]\((https?:\/\/[^)]+)\)/);
  const candidato = enlace ? enlace[1] : limpio;
  const m = candidato.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  if (!m) return null;
  const dom = m[1].toLowerCase().replace(/\.$/, '');
  if (!/\.[a-z]{2,}$/.test(dom)) return null;
  if (/^(gmail|hotmail|yahoo|outlook|live|icloud|protonmail|proton)\./.test(dom)) return null;
  return dom;
}

/** Correo dentro de una celda, si lo hay. */
function correoDeCelda(celda) {
  const m = (celda || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

/**
 * Extrae negocios de todas las tablas markdown de un texto.
 * Localiza las columnas por encabezado y valida el nombre.
 *
 * @returns {{nombre:string, dominio:string|null, correo:string|null}[]}
 */
function negociosDeTablas(texto) {
  const salida = [];
  const lineas = texto.split('\n');

  for (let i = 0; i < lineas.length - 1; i++) {
    if (!/^\|.*\|$/.test(lineas[i])) continue;
    if (!/^\|[\s:-]+\|/.test(lineas[i + 1])) continue; // separador de tabla

    const encabezados = lineas[i].split('|').slice(1, -1).map(limpiarCelda);
    if (!encabezados.length) continue;

    const iNombre = indiceColumna(encabezados, /negocio|nombre|business|empresa|place/i);
    const iUrl = indiceColumna(encabezados, /url|sitio|web|link|p[aá]gina/i);
    const iCorreo = indiceColumna(encabezados, /email|correo|contacto|mail/i);
    if (iNombre === -1) continue;

    for (let j = i + 2; j < lineas.length; j++) {
      if (!/^\|.*\|$/.test(lineas[j])) break;
      const cols = lineas[j].split('|').slice(1, -1).map(limpiarCelda);
      const nombre = cols[iNombre] || '';
      if (!esNombreValido(nombre)) continue;

      const dominio = iUrl >= 0 ? dominioDeCelda(cols[iUrl]) : null;
      let correo = iCorreo >= 0 ? correoDeCelda(cols[iCorreo]) : null;
      if (!correo) {
        correo = cols.map(correoDeCelda).find(Boolean) || null;
      }
      salida.push({ nombre, dominio, correo });
    }
  }
  return salida;
}

/**
 * ¿El asunto del correo nombra al negocio?
 *
 * Los correos de prospección llevan el nombre del negocio en el asunto
 * ("Hotel Costa Brava: su sitio tarda 17 segundos"). Si el asunto sale
 * genérico el correo se lee como spam y delata que es automático. Aquí se
 * exige coincidencia con el nombre completo o con al menos una palabra
 * significativa de él (se ignoran artículos y palabras de zona/giro que
 * aparecen en casi todos los nombres).
 */
function asuntoNombraNegocio(asunto, nombre) {
  const normalizar = (s) => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const a = normalizar(asunto);
  const n = normalizar(nombre);
  if (!a) return { ok: false, motivo: 'sin asunto' };
  if (!n) return { ok: false, motivo: 'sin nombre de negocio' };
  if (a.includes(n)) return { ok: true };

  const vacias = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'the', 'and', 'cozumel',
    'playa', 'carmen', 'hotel', 'restaurant', 'restaurante', 'tours', 'dive', 'center', 'spa', 'by']);
  const significativas = n.split(' ').filter((w) => w.length >= 4 && !vacias.has(w));
  if (significativas.length && significativas.some((w) => a.includes(w))) return { ok: true };

  return { ok: false, motivo: `el asunto no menciona el negocio ("${nombre}")` };
}

module.exports = { esNombreValido, negociosDeTablas, dominioDeCelda, correoDeCelda, limpiarCelda, asuntoNombraNegocio };
