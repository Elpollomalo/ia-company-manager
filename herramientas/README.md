# herramientas/

Utilidades internas de la agencia, no atadas a un proyecto.

## `generar-pdf.py` — propuestas y documentos membretados

Convierte un documento markdown en un PDF con el membrete de Creativa Balam. Se hizo para la
propuesta de Galería Azul (14 agosto 2026) y sirve para cualquier propuesta o documento que vaya
a un cliente.

```bash
python3 herramientas/generar-pdf.py entrada.md salida.pdf \
  --pie-izq "Galería Azul · propuesta comercial" \
  --quien-rol "Estudio de software · Cozumel, México" \
  --lang es
```

Para la versión en inglés del mismo documento, sólo cambian los textos:

```bash
python3 herramientas/generar-pdf.py entrada-en.md "salida (EN).pdf" \
  --pie-izq "Galería Azul · business proposal" \
  --quien-rol "Software studio · Cozumel, Mexico" \
  --lang en
```

### Cómo funciona

- `amd.py` convierte el markdown a HTML. Es un conversor propio, no una librería: sólo soporta lo
  que estos documentos usan (títulos h1/h2/h3, párrafos, listas, tablas, **negritas**, `código`).
- `plantilla.html` es el membrete y los estilos. Tiene placeholders (`__CUERPO__`, `__PIE_IZQ__`,
  `__PIE_DER__`, `__QUIEN_ROL__`, `__LANG__`) que `generar-pdf.py` sustituye.
- `generar-pdf.py` junta las dos cosas y llama a Chromium headless para imprimir a PDF.

### Dos cosas que hay que saber

**No usar HTML crudo en el markdown.** El conversor no lo procesa: `<div align="center">` sale
impreso literal en el PDF. Pasó con la firma de la primera propuesta de Galería Azul. Para
centrar o dar formato, ajustar `plantilla.html`, no meter HTML en el documento.

**Las líneas seguidas se juntan en un párrafo.** Si quieres que "Para:", "De:" y "Fecha:" salgan
en renglones distintos, sepáralas con una línea en blanco entre cada una.

### Dependencias

Chromium (ya instalado en este VPS, en `/snap/chromium/`) más las librerías del sistema que pide
para correr headless (`libatk1.0-0`, `libnss3`, `libgbm1`, etc. — se instalaron el 14 agosto 2026).
El script busca el binario solo; si no lo encuentra, lo dice claro en vez de fallar raro.
