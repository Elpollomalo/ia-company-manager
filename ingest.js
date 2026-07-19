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
            const contenido = fs.readFileSync(rutaArchivo, 'utf-8');

            console.log(`📦 Procesando archivo: ${archivo}`);

            let proyectoDetectado = 'General';
            const nombreMinusculas = archivo.toLowerCase();

            if (nombreMinusculas.includes('tourbrain')) proyectoDetectado = 'TourBrain';
            else if (nombreMinusculas.includes('gnga')) proyectoDetectado = 'GNGA.WEB3';
            else if (nombreMinusculas.includes('balam')) proyectoDetectado = 'Creativa Balam';
            else if (nombreMinusculas.includes('ideas')) proyectoDetectado = 'Agencia de Ideas';

            await agregarTarea(
                'catalogadores',
                proyectoDetectado,
                `Toma esta nota cruda del archivo '${archivo}' y conviértela en una o varias notas atómicas limpias en la carpeta vault/2-atoms/. No inventes nada externo.\n\nContenido original:\n${contenido}`
            );

            fs.unlinkSync(rutaArchivo);
            console.log(`🗑️ Archivo origen '${archivo}' movido exitosamente al pipeline.`);
        }

        console.log("✅ Ingesta completada de forma segura. Todas las tareas están en la cola de Redis.");
        process.exit(0);

    } catch (error) {
        console.error("❌ Error crítico durante el proceso de ingesta:", error.message);
        process.exit(1);
    }
}

ejecutarIngesta();
