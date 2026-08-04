#!/usr/bin/env python3
"""
Convierte el "Detalle de Existencias" que emite 3C Informática (el sistema viejo
de la clienta) al CSV que come la importación de conteo de /stock.

    ./scripts/existencias-pdf-a-csv.py entrada.pdf salida.csv

Por qué existe: la clienta migra desde 3C y su inventario real son reportes de
~1600 productos por sucursal, en PDF. Meter un lector de PDF en el navegador
serían ~300 KB de bundle y un parser de coordenadas corriendo en la máquina de
ella, para un formato que emite un solo sistema. El trabajo sucio se hace acá,
una vez, del lado donde se puede verificar.

DOS VALIDACIONES, y son el motivo por el que este script existe en vez de un
copiar-pegar:

  1. SUMA DE CONTROL. El reporte imprime el total de existencias en la cabecera
     del depósito. Si lo que extraemos no da ese número, algo se leyó mal y el
     script sale con error en vez de escribir un CSV plausible y equivocado.

  2. PÁGINAS COMPLETAS. Cada página dice "Página N de M". Se verifica que estén
     todas. No es teórico: el PDF de clientes que mandaron el 03/08 venía sin las
     páginas 1, 2 y 3 de 40 — 110 clientes que no estaban, y nada en el archivo
     lo decía.

El PDF no tiene tablas: escribe cada celda en una coordenada absoluta. Así que
se reconstruyen las filas agrupando por Y y ordenando por X.
"""
import base64
import csv
import re
import sys
import zlib
from collections import defaultdict

# Centros de columna, medidos sobre la fila de encabezado del reporte.
X_CODIGO = (0, 55)
X_DESCRIP = (55, 260)
X_IMP = (285, 300)
X_EXISTENCIA = (300, 380)

NUM = r"-?\d+\.?\d*"
RE_TD = re.compile(rf"({NUM})\s+({NUM})\s+(TD|Td)")
RE_TM = re.compile(rf"({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+Tm")
RE_TJ = re.compile(r"\((?:[^()\\]|\\.)*\)\s*Tj")
RE_TL = re.compile(rf"({NUM})\s+TL")


def streams(d):
    for m in re.finditer(rb"stream", d):
        i = m.end()
        while i < len(d) and d[i] in (13, 10):
            i += 1
        j = d.find(b"endstream", i)
        if j > 0:
            yield d[i:j]


def decodificar(raw):
    """Los streams vienen ASCII85 + Flate."""
    try:
        s = base64.a85decode(raw.strip(), adobe=True)
    except Exception:
        return None
    try:
        return zlib.decompress(s)
    except Exception:
        return s


def piezas(contenido):
    """[(x, y, texto)] en ORDEN DE EMISIÓN."""
    txt = contenido.decode("latin-1")
    out = []
    lx = ly = x = y = 0.0
    leading = 0.0
    for m in re.finditer(
        rf"(?P<tm>{RE_TM.pattern})|(?P<td>{RE_TD.pattern})|(?P<tj>{RE_TJ.pattern})"
        rf"|(?P<bt>\bBT\b)|(?P<tstar>\bT\*)|(?P<tl>{RE_TL.pattern})",
        txt,
    ):
        if m.group("bt"):
            lx = ly = x = y = 0.0
        elif m.group("tm"):
            g = RE_TM.match(m.group("tm"))
            lx, ly = float(g.group(5)), float(g.group(6))
            x, y = lx, ly
        elif m.group("td"):
            g = RE_TD.match(m.group("td"))
            lx += float(g.group(1))
            ly += float(g.group(2))
            if g.group(3) == "TD":
                leading = -float(g.group(2))
            x, y = lx, ly
        elif m.group("tl"):
            leading = float(RE_TL.match(m.group("tl")).group(1))
        elif m.group("tstar"):
            ly -= leading
            x, y = lx, ly
        elif m.group("tj"):
            s = m.group("tj")
            s = s[s.index("(") + 1 : s.rindex(")")]
            s = re.sub(r"\\([()\\])", r"\1", s)
            if s.strip():
                out.append((round(x, 1), round(y, 1), s))
    return out


def por_filas(pz, tol=3.0):
    grupos = defaultdict(list)
    for x, y, s in pz:
        k = next((k for k in grupos if abs(k - y) <= tol), y)
        grupos[k].append((x, s))
    return [sorted(grupos[y]) for y in sorted(grupos, reverse=True)]


def numero_de_pagina(pz):
    """
    'Página ', N, ' de ', TOTAL — los cuatro se emiten en la MISMA X, así que hay
    que leerlos por orden de emisión y no ordenando por coordenada.
    """
    t = [p[2] for p in pz]
    if "Página " not in t:
        return None
    i = t.index("Página ")
    nums = [v for v in t[i + 1 : i + 4] if v.strip().isdigit()]
    return (int(nums[0]), int(nums[1])) if len(nums) >= 2 else None


def en(x, rango):
    return rango[0] <= x < rango[1]


def main(pdf, salida):
    d = open(pdf, "rb").read()
    paginas = [pz for raw in streams(d) if (s := decodificar(raw)) and b"Tj" in s and (pz := piezas(s))]

    deposito = None
    total_reportado = None
    fecha_snapshot = None
    emitido = None
    filas = []
    vistas, totales = [], set()

    for pz in paginas:
        pag = numero_de_pagina(pz)
        if pag:
            vistas.append(pag[0])
            totales.add(pag[1])

        for celdas in por_filas(pz):
            textos = [t for _, t in celdas]
            unido = " ".join(textos)

            if m := re.search(r"Detalle de Existencias al:\s*([\d/]+)", unido):
                fecha_snapshot = m.group(1)
            if m := re.search(r"(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})", unido):
                emitido = m.group(1)
            if "Deposito:" in textos:
                # ['Deposito:', '4', "O'HIGGINS", '4421.5']
                deposito = textos[2]
                total_reportado = float(textos[3])
                continue
            if any(t.startswith(("Cód. Articulo", "Detalle de Existencias", "CASAFORMA", "3C Web")) for t in textos):
                continue
            if len(celdas) != 4:
                continue

            codigo = next((t for x, t in celdas if en(x, X_CODIGO)), None)
            descrip = next((t for x, t in celdas if en(x, X_DESCRIP)), None)
            cant = next((t for x, t in celdas if en(x, X_EXISTENCIA)), None)
            if codigo is None or cant is None:
                continue
            try:
                cantidad = float(cant)
            except ValueError:
                continue
            filas.append((codigo.strip(), (descrip or "").strip(), cantidad))

    problemas = []

    # --- 1. páginas completas ---
    faltan = sorted(set(range(1, max(totales) + 1)) - set(vistas)) if totales else []
    repetidas = sorted({p for p in vistas if vistas.count(p) > 1})
    if faltan:
        problemas.append(f"FALTAN PÁGINAS: {faltan} (el reporte dice que son {max(totales)})")
    if repetidas:
        problemas.append(f"PÁGINAS REPETIDAS: {repetidas}")

    # --- 2. cada fila tiene su código ---
    #
    # La suma de control valida el TOTAL, no el emparejamiento: si el parser
    # cruzara la cantidad de una fila con el código de otra, la suma daría igual.
    # Este chequeo cuenta cuántas celdas cayeron en la columna del código en todo
    # el documento y lo compara con las filas extraídas: si el reconstructor
    # perdió o fusionó una fila, los números no coinciden.
    celdas_codigo = 0
    for pz in paginas:
        for celdas in por_filas(pz):
            textos = [t for _, t in celdas]
            if any(t.startswith(("Cód. Articulo", "Deposito:", "CASAFORMA", "3C Web", "Detalle de")) for t in textos):
                continue
            if len(celdas) != 4:
                continue
            if any(en(x, X_CODIGO) for x, _ in celdas) and any(en(x, X_EXISTENCIA) for x, _ in celdas):
                celdas_codigo += 1
    if celdas_codigo != len(filas):
        problemas.append(
            f"filas con código+cantidad ({celdas_codigo}) != filas extraídas ({len(filas)})"
        )

    # --- 3. suma de control ---
    suma = round(sum(c for _, _, c in filas), 2)
    if total_reportado is None:
        problemas.append("no se encontró el total del depósito (no se puede verificar)")
    elif abs(suma - total_reportado) >= 0.01:
        problemas.append(f"NO CUADRA: extraído {suma} vs reporte {total_reportado}")

    # La fecha del snapshot es lo que después decide si el conteo pisa o suma
    # movimientos. Sin ella, la pantalla no puede avisar nada.
    # Con offset -03:00 EXPLÍCITO. El reporte lo emite una máquina en Argentina
    # y del otro lado hay un `timestamptz`: sin offset, Postgres lo interpreta en
    # SU zona (UTC en Supabase) y la ventana de "movimientos posteriores" queda
    # corrida tres horas — o sea, avisando de más o, peor, de menos.
    TZ = "-03:00"
    if emitido:
        dd, mm, aaaa = emitido[:10].split("-")
        fecha_iso = f"{aaaa}-{mm}-{dd}T{emitido[11:]}{TZ}"
    elif fecha_snapshot:
        dd, mm, aaaa = fecha_snapshot.split("/")
        fecha_iso = f"{aaaa}-{mm}-{dd}T00:00:00{TZ}"
    else:
        fecha_iso = ""
        problemas.append("no se encontró la fecha del reporte")

    print(f"depósito           : {deposito}")
    print(f"páginas            : {min(vistas)}–{max(vistas)} de {totales or '?'}")
    print(f"fecha del reporte  : {fecha_iso or '?'}")
    print(f"filas              : {len(filas)}")
    print(f"suma de existencias: {suma}   (reporte: {total_reportado})")

    if problemas:
        print()
        for p in problemas:
            print(f"  ✗ {p}")
        print("\nNO se escribió el CSV.")
        return 1

    with open(salida, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["deposito", "fecha_snapshot", "codigo", "descripcion", "existencia"])
        for cod, desc, cant in filas:
            w.writerow([deposito, fecha_iso, cod, desc, cant])

    print(f"\n  ✓ todo cuadra — escrito: {salida}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
