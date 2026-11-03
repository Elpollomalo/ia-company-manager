// Lote de prueba para el candado de buzón (3 nov 2026).
// Dos direcciones que no existen + una que sí. No debe salir nada a la calle:
// las dos muertas se saltan con SALTADO y la buena truena en Resend porque la
// corrida de prueba va con una API key falsa.
const DE = 'Carlos Salazar Balam <carlos@creativabalam.com.mx>';
const envolver = c => `<div style="background:#050505;color:#fff;font-family:sans-serif;padding:24px">${c}</div>`;

const CORREOS = [
  {
    para: 'info@spanishschools.com.mx',
    nombre: 'Spanish, English Academy S.E.A.',
    asunto: 'Spanish, English Academy: prueba de candado de buzón',
    cuerpo: '<p>Prueba interna. Este correo no debe salir.</p>',
  },
  {
    para: 'buzon-que-no-existe-8f3a2b9c@gmail.com',
    nombre: 'Buzón Inventado',
    asunto: 'Buzón Inventado: prueba de candado de buzón',
    cuerpo: '<p>Prueba interna. Este correo no debe salir.</p>',
  },
  {
    para: 'cristina@cedral.com',
    nombre: 'Cedral Caribe REALTORS',
    asunto: 'Cedral Caribe: prueba de candado de buzón',
    cuerpo: '<p>Prueba interna: si ves esto, el candado dejó pasar un correo válido.</p>',
  },
];

module.exports = { CORREOS, DE, envolver };
