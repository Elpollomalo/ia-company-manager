"""Convierte el markdown del documento a HTML. Sólo lo que este documento usa:
títulos, párrafos, listas con viñeta, listas numeradas, tablas y **negritas**.

Se hizo a mano en vez de traer una librería porque el documento cabe en dos
páginas y el conversor completo pesa más que el problema. La primera versión
salió mal: dejaba el "1. " dentro del texto de cada punto, así que el PDF decía
"1. 1. Abres la cuenta", y las líneas de continuación de una lista numerada se
convertían en párrafos sueltos. Por eso ahora el estado de lista es explícito.
"""

import html
import re
import sys


def enlinea(s: str) -> str:
    s = html.escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    # `código` en línea. Sin esto los acentos graves salían impresos tal cual en
    # el PDF, y un documento que va a un cliente no puede mostrar sintaxis de
    # markdown cruda.
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def celdas_de(linea: str) -> list[str]:
    return [c.strip() for c in linea.strip().strip("|").split("|")]


def es_separador_tabla(linea: str) -> bool:
    return all(re.match(r"^:?-{1,}:?$", c) for c in celdas_de(linea))


def convertir(md: str) -> str:
    salida: list[str] = []
    # ('ul' | 'ol' | 'p' | 'table' | None, [piezas])
    modo: str | None = None
    buffer: list[str] = []

    def cerrar():
        nonlocal modo, buffer
        if modo in ("ul", "ol"):
            puntos = "".join(f"<li>{enlinea(x)}</li>" for x in buffer)
            salida.append(f"<{modo}>{puntos}</{modo}>")
        elif modo == "p" and buffer:
            salida.append("<p>" + enlinea(" ".join(buffer)) + "</p>")
        elif modo == "table" and buffer:
            encabezado = celdas_de(buffer[0])
            cabeza = "".join(f"<th>{enlinea(c)}</th>" for c in encabezado)
            piezas = [f"<table><thead><tr>{cabeza}</tr></thead>"]
            if len(buffer) > 1:
                piezas.append("<tbody>")
                for fila in buffer[1:]:
                    celdas = "".join(f"<td>{enlinea(c)}</td>" for c in celdas_de(fila))
                    piezas.append(f"<tr>{celdas}</tr>")
                piezas.append("</tbody>")
            piezas.append("</table>")
            salida.append("".join(piezas))
        modo, buffer = None, []

    for cruda in md.split("\n"):
        linea = cruda.rstrip()
        desnuda = linea.strip()

        if not desnuda or desnuda == "---":
            cerrar()
            continue

        # Continuación: viene indentada y hay una lista o párrafo abierto.
        if cruda.startswith("  ") and modo:
            buffer[-1] += " " + desnuda
            continue

        if desnuda.startswith("### "):
            cerrar()
            salida.append(f"<h3>{enlinea(desnuda[4:])}</h3>")
        elif desnuda.startswith("## "):
            cerrar()
            salida.append(f"<h2>{enlinea(desnuda[3:])}</h2>")
        elif desnuda.startswith("# "):
            cerrar()
            salida.append(f"<h1>{enlinea(desnuda[2:])}</h1>")
        elif desnuda.startswith("- "):
            if modo != "ul":
                cerrar()
                modo = "ul"
            buffer.append(desnuda[2:])
        elif re.match(r"^\d+\.\s", desnuda):
            if modo != "ol":
                cerrar()
                modo = "ol"
            buffer.append(re.sub(r"^\d+\.\s+", "", desnuda))
        elif desnuda.startswith("|") and desnuda.endswith("|"):
            # La fila separadora (|---|---|) sólo marca dónde termina el
            # encabezado; no es una fila de datos y no se agrega al buffer.
            if modo == "table" and es_separador_tabla(desnuda):
                continue
            if modo != "table":
                cerrar()
                modo = "table"
            buffer.append(desnuda)
        else:
            if modo != "p":
                cerrar()
                modo = "p"
            buffer.append(desnuda)

    cerrar()
    return "\n".join(salida)


if __name__ == "__main__":
    print(convertir(open(sys.argv[1], encoding="utf-8").read()))
