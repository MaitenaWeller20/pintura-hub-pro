#!/usr/bin/env python3
"""
Convierte el listado de "Clientes" que emite 3C Informática al CSV que come la
importación de /clientes.

    ./scripts/clientes-pdf-a-csv.py entrada.pdf salida.csv
    ./scripts/clientes-pdf-a-csv.py entrada.pdf salida.csv --forzar   # aun con páginas faltantes

Hermano de `existencias-pdf-a-csv.py`: mismo PDF raro (streams ASCII85+Flate, sin
tablas, cada celda en una coordenada absoluta), misma forma de reconstruir filas.
La diferencia importante es que este reporte **no imprime ningún total**, así que
no hay suma de control: la única validación fuerte es que estén todas las
páginas.

Y no es teórica. El PDF que mandaron el 03/08/2026 arrancaba en la página 4 de
40: faltaban ~110 clientes —los de código más bajo, o sea los más viejos de la
casa— y nada en el archivo lo decía. Por eso el script se niega a escribir el CSV
si detecta un hueco.

El CSV sale con TODAS las columnas del reporte, aunque la importación después use
sólo algunas: convertir es una cosa y decidir qué se carga es otra, y si mañana
hace falta el tipo de IVA es mejor tenerlo que volver a sacar el PDF.
"""
import csv
import re
import sys
from collections import defaultdict

# Los primitivos de lectura de PDF están duplicados del conversor de existencias
# a propósito: los nombres de archivo con guiones no son importables en Python sin
# gimnasia, y estos scripts tienen que poder correrse solos, copiados a otra
# máquina, sin el resto del repo.
import base64
import zlib

NUM = r"-?\d+\.?\d*"
RE_TD = re.compile(rf"({NUM})\s+({NUM})\s+(TD|Td)")
RE_TM = re.compile(rf"({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+Tm")
RE_TJ = re.compile(r"\((?:[^()\\]|\\.)*\)\s*Tj")
RE_TL = re.compile(rf"({NUM})\s+TL")

# Bandas de X medidas sobre la fila de encabezado del reporte (es apaisado).
COLUMNAS = [
    ("codigo", 0, 50),
    ("razon_social", 50, 190),
    ("cuit", 190, 255),
    ("ingresos_brutos", 255, 320),
    ("iva", 320, 340),
    ("lista", 340, 365),
    ("cta_cte", 365, 400),
    ("zona", 400, 485),
    ("provincia", 485, 540),
    ("domicilio", 540, 700),
    ("telefono", 700, 800),
    ("estado", 800, 99999),
]


def streams(d):
    for m in re.finditer(rb"stream", d):
        i = m.end()
        while i < len(d) and d[i] in (13, 10):
            i += 1
        j = d.find(b"endstream", i)
        if j > 0:
            yield d[i:j]


def decodificar(raw):
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
    """'Página ', N, ' de ', TOTAL — los cuatro salen en la MISMA X."""
    t = [p[2] for p in pz]
    if "Página " not in t:
        return None
    i = t.index("Página ")
    nums = [v for v in t[i + 1 : i + 4] if v.strip().isdigit()]
    return (int(nums[0]), int(nums[1])) if len(nums) >= 2 else None


RUIDO = ("Código", "Clientes", "CASAFORMA", "3C Web", "Tip.Dom", "Página", " Medida")


def main(pdf, salida, forzar=False):
    d = open(pdf, "rb").read()
    paginas = [pz for raw in streams(d) if (s := decodificar(raw)) and b"Tj" in s and (pz := piezas(s))]

    filas = []
    descartadas = []
    vistas, totales = [], set()

    for pz in paginas:
        pag = numero_de_pagina(pz)
        if pag:
            vistas.append(pag[0])
            totales.add(pag[1])

        for celdas in por_filas(pz):
            textos = [t for _, t in celdas]
            if any(any(r in t for r in RUIDO) for t in textos):
                continue
            fila = {}
            for nombre, a, b in COLUMNAS:
                fila[nombre] = next((t.strip() for x, t in celdas if a <= x < b), "")
            # El código es el ancla: sin un número ahí, no es una fila de datos.
            if not fila["codigo"].isdigit():
                # Pero si la fila TIENE contenido y aun así no se le pudo leer el
                # código, algo salió mal en la reconstrucción y hay que decirlo:
                # sin total de control, una fila descartada en silencio es un
                # cliente que desaparece sin que nadie se entere.
                if any(v for k, v in fila.items() if k != "codigo"):
                    descartadas.append(textos[:4])
                continue
            filas.append(fila)

    problemas = []
    faltan = sorted(set(range(1, max(totales) + 1)) - set(vistas)) if totales else []
    repetidas = sorted({p for p in vistas if vistas.count(p) > 1})
    if not totales:
        problemas.append("no se encontró la numeración de páginas (no se puede verificar)")
    if faltan:
        problemas.append(f"FALTAN PÁGINAS: {faltan} (el reporte dice que son {max(totales)})")
    if repetidas:
        problemas.append(f"PÁGINAS REPETIDAS: {repetidas}")
    if not filas:
        problemas.append("no se extrajo ninguna fila")

    if descartadas:
        problemas.append(
            f"{len(descartadas)} filas con datos pero SIN código legible: {descartadas[:3]}"
        )

    codigos = [f["codigo"] for f in filas]
    repes = sorted({c for c in codigos if codigos.count(c) > 1})
    if repes:
        problemas.append(f"CÓDIGOS REPETIDOS ({len(repes)}): {repes[:10]}")

    print(f"páginas   : {min(vistas) if vistas else '?'}–{max(vistas) if vistas else '?'} de {totales or '?'}")
    print(f"clientes  : {len(filas)}")
    if filas:
        print(f"códigos   : {min(int(c) for c in codigos)} → {max(int(c) for c in codigos)}")
        print(f"con CUIT  : {sum(1 for f in filas if f['cuit'])}")
        print(f"cta cte S : {sum(1 for f in filas if f['cta_cte'] == 'S')}")

    if problemas and not forzar:
        print()
        for p in problemas:
            print(f"  ✗ {p}")
        print("\nNO se escribió el CSV. Si igual querés lo que se pudo leer, agregá --forzar.")
        return 1

    if problemas:
        # La importación saltea a los que ya existen por CUIT, así que cargar un
        # archivo parcial y completarlo después no duplica a nadie. Igual se
        # avisa fuerte: es lo que separa "decidí cargar una parte" de "creí que
        # había cargado todo".
        print()
        for p in problemas:
            print(f"  ⚠ {p}")
        print("\n  --forzar: se escribe igual, PERO ESTE CSV ESTÁ INCOMPLETO.")

    with open(salida, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=[c[0] for c in COLUMNAS])
        w.writeheader()
        w.writerows(filas)
    print(
        f"\n  {'⚠ INCOMPLETO' if problemas else '✓ páginas completas'} — escrito: {salida}"
    )
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(args[0], args[1], forzar="--forzar" in sys.argv))
