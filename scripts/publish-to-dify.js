#!/usr/bin/env node
// Publica vault/4-bot-brain/{proyecto}/*.md como documentos en un Dataset
// (Knowledge Base) de Dify, vía su Knowledge API. Uso manual, disparado a
// mano por un humano después de revisar tono/contenido — no forma parte
// del pipeline automático del worker.
//
// Uso: node scripts/publish-to-dify.js <proyecto>
//
// Cada proyecto puede vivir en una cuenta/workspace de Dify distinta, así que
// la API key (y opcionalmente la URL base) se buscan primero por proyecto y
// si no existen, caen a la variable genérica:
//   DIFY_API_KEY_<PROYECTO>     (ej: DIFY_API_KEY_GNGA_WEB3)   → si no está, usa DIFY_API_KEY
//   DIFY_BASE_URL_<PROYECTO>    (ej: DIFY_BASE_URL_GNGA_WEB3)  → si no está, usa DIFY_BASE_URL
// <PROYECTO> = el nombre del proyecto en mayúsculas, con guiones/espacios
// convertidos a guión bajo (gnga-web3 → GNGA_WEB3).
//
// Requiere en dify-datasets.json: el dataset_id del proyecto (se crea una
// vez a mano en Dify y se pega ahí, no es secreto).

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname + '/..';

function slugEntorno(proyecto) {
    return proyecto.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function variableProyecto(proyecto, sufijo, valorPorDefecto) {
    const slug = slugEntorno(proyecto);
    return process.env[`${sufijo}_${slug}`] || process.env[sufijo] || valorPorDefecto;
}

async function difyFetch(baseUrl, apiKey, pathSuffix, options = {}) {
    const respuesta = await fetch(`${baseUrl}${pathSuffix}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });
    if (!respuesta.ok) {
        const errorTexto = await respuesta.text();
        throw new Error(`Dify ${respuesta.status} en ${pathSuffix}: ${errorTexto}`);
    }
    return respuesta.json();
}

async function listarDocumentosExistentes(baseUrl, apiKey, datasetId) {
    const mapa = new Map(); // name -> document_id
    let pagina = 1;
    while (true) {
        const resultado = await difyFetch(baseUrl, apiKey, `/datasets/${datasetId}/documents?page=${pagina}&limit=100`);
        for (const doc of resultado.data || []) {
            mapa.set(doc.name, doc.id);
        }
        if (!resultado.has_more) break;
        pagina += 1;
    }
    return mapa;
}

async function publicarArchivo(baseUrl, apiKey, datasetId, nombre, texto, idExistente) {
    if (idExistente) {
        await difyFetch(baseUrl, apiKey, `/datasets/${datasetId}/documents/${idExistente}/update-by-text`, {
            method: 'POST',
            body: JSON.stringify({ name: nombre, text: texto }),
        });
        return 'actualizado';
    }
    await difyFetch(baseUrl, apiKey, `/datasets/${datasetId}/document/create-by-text`, {
        method: 'POST',
        body: JSON.stringify({
            name: nombre,
            text: texto,
            indexing_technique: 'high_quality',
            process_rule: { mode: 'automatic' },
        }),
    });
    return 'creado';
}

async function main() {
    const proyecto = process.argv[2];
    if (!proyecto) {
        console.error('Uso: node scripts/publish-to-dify.js <proyecto>');
        process.exit(1);
    }

    const apiKey = variableProyecto(proyecto, 'DIFY_API_KEY');
    const baseUrl = variableProyecto(proyecto, 'DIFY_BASE_URL', 'https://api.dify.ai/v1');
    if (!apiKey) {
        const slug = slugEntorno(proyecto);
        console.error(`Falta la API key de Dify para '${proyecto}' — pon DIFY_API_KEY_${slug} (o DIFY_API_KEY genérica) en .env. Es la API key del Dataset en Dify (Knowledge → API Access), no la de una app.`);
        process.exit(1);
    }

    const datasetsPath = path.join(PROJECT_ROOT, 'dify-datasets.json');
    const datasets = JSON.parse(fs.readFileSync(datasetsPath, 'utf-8'));
    const datasetId = datasets[proyecto];
    if (!datasetId) {
        console.error(`No hay dataset_id para '${proyecto}' en dify-datasets.json. Crea el Dataset en Dify y pega su ID ahí (no es secreto, solo un identificador).`);
        process.exit(1);
    }

    const sourceDir = path.join(PROJECT_ROOT, 'vault', '4-bot-brain', proyecto);
    if (!fs.existsSync(sourceDir)) {
        console.error(`No existe ${sourceDir}`);
        process.exit(1);
    }

    const archivos = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'));
    if (archivos.length === 0) {
        console.error(`No hay archivos .md en ${sourceDir}`);
        process.exit(1);
    }

    console.log(`📚 Publicando ${archivos.length} documento(s) de '${proyecto}' al dataset ${datasetId} (${baseUrl})...`);
    const existentes = await listarDocumentosExistentes(baseUrl, apiKey, datasetId);

    const resultados = { creado: [], actualizado: [], error: [] };
    for (const nombre of archivos) {
        const rutaCompleta = path.join(sourceDir, nombre);
        const texto = fs.readFileSync(rutaCompleta, 'utf-8');
        try {
            const accion = await publicarArchivo(baseUrl, apiKey, datasetId, nombre, texto, existentes.get(nombre));
            resultados[accion].push(nombre);
            console.log(`  ✓ ${nombre} — ${accion}`);
        } catch (err) {
            resultados.error.push(`${nombre}: ${err.message}`);
            console.error(`  ✗ ${nombre} — ${err.message}`);
        }
    }

    const huerfanos = archivos.length
        ? [...existentes.keys()].filter((n) => !archivos.includes(n))
        : [];
    if (huerfanos.length > 0) {
        console.log(`\n⚠️ Documentos en el dataset de Dify que ya no existen en ${sourceDir} (no se borraron, revisar a mano si aplica):`);
        huerfanos.forEach((n) => console.log(`  - ${n}`));
    }

    console.log(`\nResumen: ${resultados.creado.length} creados, ${resultados.actualizado.length} actualizados, ${resultados.error.length} con error.`);
    if (resultados.error.length > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Fallo publicando a Dify:', err.message);
    process.exit(1);
});
