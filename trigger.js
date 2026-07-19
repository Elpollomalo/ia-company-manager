const { agregarTarea } = require('./queue');

async function dispararPrueba() {
    console.log("🚀 Preparando envío de tarea de prueba al enjambre...");

    // Inyectamos una tarea real usando la estructura agnóstica
    await agregarTarea(
        'programadores',      // Agente que requiere el playbook
        'TourBrain',         // Proyecto activo
        'Diseñar la estructura base de datos para los bots de Cozumel' // Tarea específica
    );

    console.log("✅ Tarea inyectada con éxito. Puedes revisar la terminal del worker.");
    process.exit(0);
}

dispararPrueba();
