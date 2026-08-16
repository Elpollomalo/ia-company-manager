#!/usr/bin/env python3
"""Genera un PDF membretado a partir de un documento markdown.

Usa amd.py para convertir el markdown a HTML, lo mete en plantilla.html
(el membrete de Creativa Balam) y llama a Chromium headless para imprimir
a PDF. Pensado para propuestas y documentos que van a un cliente.

Uso:
    python3 herramientas/generar-pdf.py doc.md salida.pdf \
        --pie-izq "Galería Azul · propuesta comercial" \
        --quien-rol "Estudio de software · Cozumel, México" \
        --lang es
"""

import argparse
import pathlib
import subprocess
import sys

RAIZ = pathlib.Path(__file__).parent
sys.path.insert(0, str(RAIZ))
from amd import convertir  # noqa: E402

CHROME_CANDIDATOS = [
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
]


def chrome_binario() -> str:
    for candidato in CHROME_CANDIDATOS:
        ruta = pathlib.Path(candidato)
        if ruta.exists():
            return str(ruta)
    # snap versiona la carpeta (3499, 3507...); "current" a veces no está.
    for base in pathlib.Path("/snap/chromium").glob("*/usr/lib/chromium-browser/chrome"):
        return str(base)
    raise SystemExit("No encontré un binario de Chromium para generar el PDF.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("markdown", type=pathlib.Path)
    ap.add_argument("salida_pdf", type=pathlib.Path)
    ap.add_argument("--pie-izq", default="")
    ap.add_argument("--pie-der", default="creativabalam.com.mx")
    ap.add_argument("--quien-rol", default="Estudio de software · Cozumel, México")
    ap.add_argument("--lang", default="es")
    args = ap.parse_args()

    cuerpo = convertir(args.markdown.read_text(encoding="utf-8"))
    plantilla = (RAIZ / "plantilla.html").read_text(encoding="utf-8")
    html = (
        plantilla.replace("__CUERPO__", cuerpo)
        .replace("__PIE_IZQ__", args.pie_izq)
        .replace("__PIE_DER__", args.pie_der)
        .replace("__QUIEN_ROL__", args.quien_rol)
        .replace("__LANG__", args.lang)
    )

    html_tmp = args.salida_pdf.with_suffix(".html")
    html_tmp.write_text(html, encoding="utf-8")

    subprocess.run(
        [
            chrome_binario(),
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            f"--print-to-pdf={args.salida_pdf}",
            "--print-to-pdf-no-header",
            "--no-pdf-header-footer",
            f"file://{html_tmp.resolve()}",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    html_tmp.unlink()
    print(f"OK: {args.salida_pdf}")


if __name__ == "__main__":
    main()
