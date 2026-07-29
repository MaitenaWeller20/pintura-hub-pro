import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  FIELDS_TARGET,
  type ProductoGuardado,
  autoMapear,
  calcularFila,
  columnasDuplicadas,
  detectarFilaEncabezados,
  normalizar,
  numOr,
  sugeridoSinMapear,
} from "@/lib/importar-productos";
import { DESCUENTO_PROVEEDOR_DEFAULT, MARKUP_DEFAULT } from "@/lib/precios";
import { traerTodo } from "@/lib/supabase-paginado";
import { fmtMoney } from "@/lib/format";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/productos/importar")({
  component: ImportarProductos,
});

type Row = Record<string, any>;
// El mapeo de columnas (campos destino, sinónimos, parseo de números) vive en
// src/lib/importar-productos.ts para poder testearlo.
//
// REGLA que se paga cara si se rompe: esta pantalla actualiza PRECIOS y DATOS
// DEL PRODUCTO, y NO toca el stock. Hasta el 24/07/2026 ofrecía destinos "Stock
// O'Higgins" / "Stock General Paz" que hacían un upsert ABSOLUTO sobre
// stock_sucursal y sin kardex; como la lista de Quimexur no trae stock y su
// única columna numérica libre es ENV., el inventario de producción terminó
// cargado con el tamaño de envase. El stock se carga aparte: Ingresos de
// mercadería, Compras o el ajuste de Inventario, siempre con kardex.
// Ver docs/superpowers/specs/2026-07-24-stock-no-es-envase-design.md.

// Parsea una hoja detectando la fila de encabezados: en las listas reales el
// título ("LISTA DE PRECIOS N° ...") ocupa las primeras filas y los encabezados
// (CÓDIGO, DESCRIPCIÓN, PRECIO DE LISTA) están más abajo.
function parsearHoja(ws: any): { rows: Row[]; headers: string[] } {
  const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: "" });
  const headerIdx = detectarFilaEncabezados(aoa);
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { range: headerIdx, defval: "" });
  const headers = Object.keys(rows[0] ?? {});
  return { rows, headers };
}

function ImportarProductos() {
  const navigate = useNavigate();
  const { data: cu } = useCurrentUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Array<{ row: number; msg: string }>>([]);
  const [wb, setWb] = useState<any>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetSel, setSheetSel] = useState<string>("");
  // Parámetros de precio (se inicializan desde settings y se guardan al importar).
  const [descuento, setDescuento] = useState<number>(DESCUENTO_PROVEEDOR_DEFAULT);
  const [markupDef, setMarkupDef] = useState<number>(MARKUP_DEFAULT);
  // Lo que ya está en el catálogo, por código: el sugerido y el markup propio de
  // cada producto (ver calcularFila). Paginado, porque PostgREST corta en 1000 sin
  // avisar y el catálogo tiene más: sin paginar, los últimos productos importarían
  // con el cálculo equivocado y nadie se enteraría.
  const [guardados, setGuardados] = useState<Map<string, ProductoGuardado>>(new Map());
  const [catalogoListo, setCatalogoListo] = useState(false);
  useEffect(() => {
    supabase
      .from("settings")
      .select("markup_default_porcentaje, descuento_proveedor_porcentaje")
      .maybeSingle()
      .then(({ data }) => {
        if (data?.descuento_proveedor_porcentaje != null)
          setDescuento(Number(data.descuento_proveedor_porcentaje));
        if (data?.markup_default_porcentaje != null)
          setMarkupDef(Number(data.markup_default_porcentaje));
      });
  }, []);
  useEffect(() => {
    let vivo = true;
    traerTodo<{
      codigo: string;
      precio_sugerido_publico: number | null;
      markup_porcentaje: number | null;
    }>(async (desde, hasta) => {
      const { data, error, count } = await supabase
        .from("productos")
        .select("codigo, precio_sugerido_publico, markup_porcentaje", { count: "exact" })
        .order("codigo")
        .range(desde, hasta);
      return { data, error, count };
    })
      .then(({ filas, truncado }) => {
        if (!vivo) return;
        setGuardados(
          new Map(
            filas.map((p) => [
              p.codigo,
              {
                precio_sugerido_publico:
                  p.precio_sugerido_publico == null ? null : Number(p.precio_sugerido_publico),
                markup_porcentaje: p.markup_porcentaje == null ? null : Number(p.markup_porcentaje),
              },
            ]),
          ),
        );
        // Si quedó incompleto, importar recalcularía mal los productos que faltan.
        // Mejor no dejar importar que corromper precios en silencio.
        setCatalogoListo(!truncado);
        if (truncado) toast.error("No se pudo leer el catálogo completo. Recargá la página.");
      })
      .catch((e) => {
        if (!vivo) return;
        setCatalogoListo(false);
        toast.error(`No se pudo leer el catálogo: ${e.message}`);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const aplicarDatos = (parsedRows: Row[], parsedHeaders: string[]) => {
    setRows(parsedRows);
    setHeaders(parsedHeaders);
    setMapping(autoMapear(parsedHeaders));
  };

  // Al elegir una solapa del Excel, la re-parseamos (detectando la fila de headers).
  const procesarSolapa = (wb: any, name: string) => {
    setSheetSel(name);
    const { rows: rr, headers: hh } = parsearHoja(wb.Sheets[name]);
    aplicarDatos(rr, hh);
  };

  const handleFile = (f: File) => {
    setErrors([]);
    const ext = f.name.split(".").pop()?.toLowerCase();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target?.result;
      if (ext === "csv") {
        setWb(null);
        setSheetNames([]);
        const parsed = Papa.parse<Row>(data as string, { header: true, skipEmptyLines: true });
        aplicarDatos(parsed.data, parsed.meta.fields ?? []);
      } else {
        // El Excel de Quimex tiene varias solapas (la que sirve es "LISTA PLANA").
        // Guardamos el libro y dejamos elegir la solapa; así se sube el archivo
        // ORIGINAL sin re-guardarlo (re-guardarlo en Excel-es corrompe los decimales).
        const wbk = XLSX.read(data, { type: "binary" });
        setWb(wbk);
        setSheetNames(wbk.SheetNames);
        // Elegimos por defecto una solapa "plana" si existe; si no, la primera.
        const plana =
          wbk.SheetNames.find((n: string) => normalizar(n).includes("plana")) ?? wbk.SheetNames[0];
        procesarSolapa(wbk, plana);
      }
    };
    if (ext === "csv") reader.readAsText(f);
    else reader.readAsBinaryString(f);
  };

  const confirmar = async () => {
    setBusy(true);
    const errs: Array<{ row: number; msg: string }> = [];
    // Cache categorías/marcas
    const { data: cats = [] } = await supabase.from("categorias").select("*");
    const { data: mks = [] } = await supabase.from("marcas").select("*");
    // Parámetros de precio elegidos en la UI; se persisten para próximas importaciones.
    const markupDefault = Number(markupDef) || MARKUP_DEFAULT;
    const descuentoProveedor = Number(descuento) || 0;
    // Persistir estos parámetros como default global es una escritura admin-only
    // (RLS: solo is_admin puede tocar settings). Un empleado igual puede importar
    // usando los valores de la pantalla; simplemente no los guarda como default,
    // así evitamos disparar un PATCH que la RLS rechazaría con 403.
    if (cu?.isAdmin) {
      await supabase
        .from("settings")
        .update({
          markup_default_porcentaje: markupDefault,
          descuento_proveedor_porcentaje: descuentoProveedor,
        })
        .eq("id", true);
    }
    const catMap = new Map((cats ?? []).map((c: any) => [c.nombre.toLowerCase(), c.id]));
    const mkMap = new Map((mks ?? []).map((m: any) => [m.nombre.toLowerCase(), m.id]));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const codigo = String(r[mapping.codigo] ?? "").trim();
        const nombre = String(r[mapping.nombre] ?? "").trim();
        if (!codigo || !nombre) {
          errs.push({ row: i + 2, msg: "Falta código o nombre" });
          continue;
        }

        // Cat / marca
        let cat_id = null,
          mk_id = null;
        if (mapping.categoria) {
          const v = String(r[mapping.categoria] ?? "").trim();
          if (v) {
            cat_id = catMap.get(v.toLowerCase());
            if (!cat_id) {
              const { data } = await supabase
                .from("categorias")
                .insert({ nombre: v })
                .select()
                .single();
              cat_id = data?.id;
              if (cat_id) catMap.set(v.toLowerCase(), cat_id);
            }
          }
        }
        if (mapping.marca) {
          const v = String(r[mapping.marca] ?? "").trim();
          if (v) {
            mk_id = mkMap.get(v.toLowerCase());
            if (!mk_id) {
              const { data } = await supabase
                .from("marcas")
                .insert({ nombre: v })
                .select()
                .single();
              mk_id = data?.id;
              if (mk_id) mkMap.set(v.toLowerCase(), mk_id);
            }
          }
        }

        // Toda la cadena de precios vive en src/lib/precios.ts. Acá sólo se traduce
        // la fila y se decide qué se escribe.
        const f = calcularFila(
          r,
          mapping,
          { descuento: descuentoProveedor, markupDefault },
          guardados.get(codigo),
        );

        // Un valor absurdo (típicamente el separador decimal mal interpretado: un
        // Excel en español que lee "2136004.80" como 213600480) daría el críptico
        // "numeric field overflow" de Postgres. Lo atajamos con un mensaje claro.
        const LIMITE = 999_999_999; // ningún precio de pinturería llega a mil millones
        for (const [campo, val, raw] of [
          ["precio de lista", f.precio_lista, mapping.precio_lista ? r[mapping.precio_lista] : ""],
          [
            "precio de fábrica",
            f.precio_fabrica,
            mapping.precio_fabrica ? r[mapping.precio_fabrica] : "",
          ],
          [
            "sugerido al público",
            f.precio_sugerido_publico ?? 0,
            mapping.precio_sugerido_publico ? r[mapping.precio_sugerido_publico] : "",
          ],
          [
            "precio s/IVA",
            f.precio_sin_iva,
            mapping.precio_sin_iva ? r[mapping.precio_sin_iva] : "",
          ],
        ] as [string, number, unknown][]) {
          if (val > LIMITE) {
            throw new Error(
              `El ${campo} (${raw || val}) parece mal formateado. Suele pasar al abrir el Excel de Quimex en Excel con configuración argentina, que interpreta el punto decimal como separador de miles. Subí el archivo original sin re-guardarlo, o revisá el separador decimal.`,
            );
          }
        }

        const payload = {
          codigo,
          nombre,
          // Re-importar un código lo trae de vuelta al catálogo activo: si estaba
          // archivado (eliminado), se desarchiva — lo estás cargando de la lista real.
          archivado: false,
          categoria_id: cat_id ?? null,
          marca_id: mk_id ?? null,
          unidad_medida: String(r[mapping.unidad_medida] ?? "unidad") || "unidad",
          precio_lista: +f.precio_lista.toFixed(2),
          precio_fabrica: f.precio_fabrica,
          precio_sin_iva: f.precio_sin_iva,
          // normalizarIva descarta lo que no sea una alícuota de AFIP. Importa más
          // que antes: el IVA pasó a ser un DIVISOR (el sugerido viene c/IVA), así
          // que un valor basura ya no ensucia la vista, corrompe lo que se factura.
          iva_porcentaje: f.iva_porcentaje,
          stock_minimo: numOr(r[mapping.stock_minimo], 0),
          // R8: tamaño de envase (ENV). Vacío -> null (no todo producto lo trae).
          tamano_envase: f.envase,
          // Sólo se escribe el sugerido si la columna está mapeada. Si no lo está,
          // la clave se omite y el upsert no pisa lo que ya había guardado — que es
          // justamente lo que calcularFila usó para derivar el precio de esta fila.
          ...(mapping.precio_sugerido_publico
            ? { precio_sugerido_publico: f.precio_sugerido_publico }
            : {}),
        };
        // Deliberadamente NO se escribe stock_sucursal acá: la lista de precios no
        // trae stock (ver el comentario del encabezado del archivo).
        const { error } = await supabase
          .from("productos")
          .upsert(payload, { onConflict: "codigo" });
        if (error) throw error;
      } catch (e: any) {
        errs.push({ row: i + 2, msg: e.message });
      }
    }
    setBusy(false);
    setErrors(errs);
    if (errs.length === 0) {
      toast.success(`${rows.length} productos importados`);
      navigate({ to: "/productos" });
    } else {
      toast.warning(`Importación con ${errs.length} errores. Revisá el detalle abajo.`);
    }
  };

  // La vista previa calcula lo mismo que la importación, con la misma función:
  // lo que se ve es lo que se guarda.
  const paramsPrecio = {
    descuento: Number(descuento) || 0,
    markupDefault: Number(markupDef) || MARKUP_DEFAULT,
  };
  const calculadas = useMemo(
    () =>
      !mapping.codigo || !mapping.nombre
        ? []
        : rows.map((r) => {
            const codigo = String(r[mapping.codigo] ?? "").trim();
            return calcularFila(r, mapping, paramsPrecio, guardados.get(codigo));
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, mapping, guardados, paramsPrecio.descuento, paramsPrecio.markupDefault],
  );
  const previa = calculadas.slice(0, 10);
  const resumen = useMemo(() => {
    const r = { sugerido: 0, costo: 0, manual: 0 };
    for (const f of calculadas) r[f.origen]++;
    return r;
  }, [calculadas]);

  const avisos = useMemo(() => {
    const out: string[] = [];
    for (const col of columnasDuplicadas(mapping)) {
      out.push(
        `La columna "${col.trim()}" está mapeada en más de un campo. Casi nunca es lo que se quiere: revisá que cada campo apunte a su columna.`,
      );
    }
    const sinMapear = sugeridoSinMapear(headers, mapping);
    if (sinMapear) {
      out.push(
        `El archivo trae la columna "${sinMapear.trim()}" y no está mapeada a "Sugerido al público (C/IVA)". Sin esa columna, el precio de venta se calcula desde el costo y queda por debajo del precio que sugiere el proveedor.`,
      );
    }
    return out;
  }, [mapping, headers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/productos" })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">Importar productos</h1>
      </div>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Subí el Excel de Quimex <strong>tal cual</strong> (.xlsx) o un CSV. Si es el Excel de
          Quimex, elegí la solapa
          <strong> LISTA PLANA</strong>. Evitá abrirlo y re-guardarlo antes de subirlo: puede
          corromper los decimales.
        </p>
        <p className="text-sm text-muted-foreground">
          Esta importación actualiza <strong>precios y datos del producto</strong>.{" "}
          <strong>No toca el stock</strong>: el stock se carga aparte, desde Ingresos de mercadería,
          Compras o el ajuste de Inventario. La columna <strong>ENV.</strong> de la lista es el{" "}
          <strong>tamaño de envase</strong>, no la cantidad en depósito.
        </p>
        <Input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        {sheetNames.length > 1 && (
          <div className="max-w-xs">
            <Label>Solapa del Excel</Label>
            <Select value={sheetSel} onValueChange={(v) => wb && procesarSolapa(wb, v)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sheetNames.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <>
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Parámetros de precio</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Descuento de proveedor (Quimex) %</Label>
                <Input
                  type="number"
                  value={descuento}
                  onChange={(e) => setDescuento(Number(e.target.value))}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  El costo se calcula como precio de lista − este %.
                </p>
              </div>
              <div>
                <Label>Markup default %</Label>
                <Input
                  type="number"
                  value={markupDef}
                  onChange={(e) => setMarkupDef(Number(e.target.value))}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Se aplica al <strong>precio sugerido al público</strong>. Si el producto no tiene
                  sugerido, se aplica al costo. Los productos con markup propio conservan el suyo.
                </p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Mapeo de columnas</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {FIELDS_TARGET.map((f) => (
                <div key={f.key}>
                  <Label>{f.label}</Label>
                  <Select
                    value={mapping[f.key] ?? "__none__"}
                    onValueChange={(v) =>
                      setMapping((m) => ({ ...m, [f.key]: v === "__none__" ? "" : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— (sin mapear)</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </Card>

          {avisos.length > 0 && (
            <Card className="p-4 border-warning/50 bg-warning/5">
              <h3 className="font-semibold mb-2 flex items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4" /> Revisá el mapeo
              </h3>
              <ul className="text-xs space-y-1 list-disc pl-4">
                {avisos.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-4">
            <h3 className="font-semibold mb-1">Vista previa ({rows.length} filas)</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Estos son los precios que se van a guardar, ya calculados.{" "}
              {resumen.sugerido > 0 && (
                <>
                  <strong>{resumen.sugerido}</strong> desde el sugerido al público
                  {" · "}
                </>
              )}
              {resumen.costo > 0 && (
                <>
                  <strong>{resumen.costo}</strong> desde el costo
                  {resumen.manual > 0 && " · "}
                </>
              )}
              {resumen.manual > 0 && (
                <>
                  <strong>{resumen.manual}</strong> con el precio de la planilla
                </>
              )}
            </p>
            <div className="max-h-64 overflow-auto text-xs">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead className="text-right">Env.</TableHead>
                    <TableHead className="text-right">Lista Quimex</TableHead>
                    <TableHead className="text-right">Costo (−{descuento}%)</TableHead>
                    <TableHead className="text-right">Costo c/IVA</TableHead>
                    <TableHead className="text-right">Sugerido público</TableHead>
                    <TableHead className="text-right">Venta c/IVA</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previa.map((f, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono">{f.codigo}</TableCell>
                      <TableCell>{f.nombre}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {f.envase ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {f.precio_lista ? fmtMoney(f.precio_lista) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {f.precio_fabrica ? fmtMoney(f.precio_fabrica) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {f.costo_c_iva ? fmtMoney(f.costo_c_iva) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {f.precio_sugerido_publico ? fmtMoney(f.precio_sugerido_publico) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold">
                        {fmtMoney(f.venta_c_iva)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Button
              className="mt-3"
              onClick={confirmar}
              disabled={busy || !mapping.codigo || !mapping.nombre || !catalogoListo}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirmar importación
            </Button>
            {!mapping.codigo || !mapping.nombre ? (
              <p className="text-xs text-muted-foreground mt-2">Mapeá al menos Código y Nombre.</p>
            ) : !catalogoListo ? (
              <p className="text-xs text-muted-foreground mt-2">Leyendo el catálogo…</p>
            ) : null}
          </Card>

          {errors.length > 0 && (
            <Card className="p-4 border-destructive/40">
              <h3 className="font-semibold text-destructive mb-2">Errores ({errors.length})</h3>
              <ul className="text-xs space-y-1 max-h-48 overflow-auto">
                {errors.map((e, i) => (
                  <li key={i}>
                    Fila {e.row}: {e.msg}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
