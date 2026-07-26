// Genera un informe consolidado de TODAS las zonas prospectadas hasta ahora,
// juntando el informe más reciente de cada zona en un solo archivo .md.
// Se puede volver a correr cuando se agreguen zonas nuevas: `node scripts/generar-resumen-prospeccion.js`
const fs = require('fs');
const path = require('path');
const { notificar } = require('./telegram-notify');

const BASE_DIR = path.join(__dirname, '..', 'vault', '7-prospeccion-negocios');
const OUT_FILE = path.join(BASE_DIR, 'RESUMEN-GENERAL.md');

const zonas = fs.readdirSync(BASE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

const filas = [];
const secciones = [];

for (const zona of zonas) {
    const carpetaInformes = path.join(BASE_DIR, zona, 'informes');
    if (!fs.existsSync(carpetaInformes)) continue;
    const archivos = fs.readdirSync(carpetaInformes).filter((f) => f.endsWith('.md')).sort();
    if (archivos.length === 0) continue;
    const masReciente = archivos[archivos.length - 1];
    const contenido = fs.readFileSync(path.join(carpetaInformes, masReciente), 'utf-8');
    // Los informes no siempre usan el mismo nivel de encabezado para cada negocio
    // (### vs #### según la corrida) -- se aceptan ambos.
    const cantidadNegocios = (contenido.match(/^#{2,4} \d+\./gm) || []).length;
    const fecha = masReciente.replace('.md', '');

    filas.push(`| ${zona} | ${cantidadNegocios} | ${fecha} |`);
    secciones.push(`\n---\n\n## 📍 ${zona.charAt(0).toUpperCase() + zona.slice(1).replace(/-/g, ' ')} (informe del ${fecha})\n\n${contenido}`);
}

const totalNegocios = filas.reduce((acc, fila) => acc + parseInt(fila.split('|')[2].trim(), 10), 0);

const doc = `# 📊 Resumen general — Prospección de negocios (Creativa Balam)

*Generado automáticamente el ${new Date().toISOString().slice(0, 10)} — combina el informe más reciente de cada zona. Volver a correr \`node scripts/generar-resumen-prospeccion.js\` cuando se agreguen zonas nuevas.*

Este es el embudo de ventas de Creativa Balam: cada negocio real encontrado aquí es un cliente
potencial. Para armarle una propuesta a alguno en particular, ver
\`vault/sources/creativa-balam/prospectos/\`.

## Totales

| Zona | Negocios encontrados | Fecha del informe |
|---|---|---|
${filas.join('\n')}

**Total de negocios únicos registrados: ${totalNegocios}** (across ${filas.length} zona${filas.length === 1 ? '' : 's'})

${secciones.join('\n')}
`;

fs.writeFileSync(OUT_FILE, doc, 'utf-8');
console.log(`Escrito: ${OUT_FILE} (${totalNegocios} negocios en ${filas.length} zonas)`);

// Copia también a la raíz de /archivos (FileBrowser) para que Carlos lo tenga a un clic de
// descargar, sin tener que entrar a la subcarpeta de prospección.
const COPIA_FILEBROWSER = '/archivos/RESUMEN-GENERAL.md';
try {
    fs.copyFileSync(OUT_FILE, COPIA_FILEBROWSER);
    console.log(`Copiado también a: ${COPIA_FILEBROWSER}`);
} catch (err) {
    console.warn(`No se pudo copiar a ${COPIA_FILEBROWSER}: ${err.message}`);
}

notificar(`✅ resumen-prospeccion: ${totalNegocios} negocios en ${filas.length} zona${filas.length === 1 ? '' : 's'}.`);
