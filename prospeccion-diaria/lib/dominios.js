/**
 * Dominios compartidos: buzones de proveedores gratuitos donde muchos clientes
 * distintos viven en el mismo dominio.
 *
 * Por qué importa (3 nov 2026): cuando un correo rebota, el filtro diario
 * bloqueaba **el dominio completo**. Con un dominio de empresa eso es correcto
 * (si contacto@empresa.com no existe, el negocio no recibe por ahí). Pero si el
 * que rebotó fue `itzelranda@hotmail.com`, bloquear `hotmail.com` dejaría fuera a
 * todos los prospectos de Hotmail —que son muchos— por culpa de un solo buzón
 * muerto. En dominio compartido se aísla la dirección; el dominio sigue vivo.
 */
const COMPARTIDOS = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.es', 'hotmail.com.mx', 'outlook.com', 'outlook.es', 'live.com', 'live.com.mx', 'msn.com',
  'yahoo.com', 'yahoo.com.mx', 'ymail.com', 'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'gmail.com.mx',
]);

function esCompartido(dominio) {
  return COMPARTIDOS.has(String(dominio || '').toLowerCase().trim());
}

module.exports = { esCompartido, COMPARTIDOS };
