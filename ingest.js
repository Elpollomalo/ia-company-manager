const fs = require('fs');
const path = require('path');
const { agregarTarea } = require('./queue');

const RAW_DIR = path.join(__dirname, 'vault', '0-raw');

async function ejecutarIngesta() {
    console.log("📥 Escaneando la carpeta vault/0-raw/ en busca de nuevas notas crudas...");

    try {
        if (!fs.existsSync(RAW_DIR)) {
            fs.mkdirSync(RAW_DIR, { recursive: true });
        }

        const archivos = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.md') || f.endsWith('.txt'));

        if (archivos.length === 0) {
            console.log("💤 No hay notas nuevas para procesar. El enjambre sigue en espera.");
            process.exit(0);
        }

        for (const archivo of archivos) {
            const rutaArchivo = path.join(RAW_DIR, archivo);

            console.log(`📦 Procesando archivo: ${archivo}`);

            // "proyecto" es siempre el slug real de la carpeta en vault/sources/ — nunca un
            // nombre "bonito" — para que no exista ningún punto de la cadena (aquí, worker.js,
            // trigger.js) donde proyecto.toLowerCase() deje de coincidir con la carpeta real.
            let proyectoDetectado = 'general';
            const nombreMinusculas = archivo.toLowerCase();

            if (nombreMinusculas.includes('tourbrain')) proyectoDetectado = 'tourbrain';
            else if (nombreMinusculas.includes('gnga')) proyectoDetectado = 'gnga-web3';
            else if (nombreMinusculas.includes('balam')) proyectoDetectado = 'creativa-balam';
            else if (nombreMinusculas.includes('ideas')) proyectoDetectado = 'agencia-ideas';

            // Movemos la fuente a vault/sources/ ANTES de encolar la tarea (no la borramos):
            // catalogadores exige que toda nota tenga una fuente verificable en el vault
            // ("sin fuente, no hay nota"), y ese archivo debe seguir existiendo cuando el
            // worker la procese.
            const proyectoSlug = proyectoDetectado;
            const carpetaDestino = path.join(__dirname, 'vault', 'sources', proyectoSlug);
            fs.mkdirSync(carpetaDestino, { recursive: true });
            const rutaDestino = path.join(carpetaDestino, archivo);
            fs.renameSync(rutaArchivo, rutaDestino);
            console.log(`📚 Archivo origen '${archivo}' movido a vault/sources/${proyectoSlug}/ como fuente permanente.`);

            await agregarTarea(
                'catalogadores',
                proyectoDetectado,
                `Toma la fuente 'vault/sources/${proyectoSlug}/${archivo}' y conviértela en una o varias notas atómicas limpias en la carpeta vault/2-atoms/. No inventes nada externo.`
            );
        }

        console.log("✅ Ingesta completada de forma segura. Todas las tareas están en la cola de Redis.");
        process.exit(0);

    } catch (error) {
        console.error("❌ Error crítico durante el proceso de ingesta:", error.message);
        process.exit(1);
    }
}

ejecutarIngesta();
