import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/productos/importar")({
  component: ImportarProductos,
});

type Row = Record<string, any>;
const fieldsTarget = [
  { key: "codigo", label: "Código *" },
  { key: "nombre", label: "Nombre *" },
  { key: "precio_lista", label: "Precio de lista (Quimex)" },
  { key: "precio_fabrica", label: "Precio fábrica (costo)" },
  { key: "precio_sin_iva", label: "Precio s/IVA" },
  { key: "iva_porcentaje", label: "IVA %" },
  { key: "stock_minimo", label: "Stock mínimo" },
  { key: "tamano_envase", label: "Envase (ENV)" },
  { key: "unidad_medida", label: "Unidad" },
  { key: "categoria", label: "Categoría (texto)" },
  { key: "marca", label: "Marca (texto)" },
  { key: "stock_ohi", label: "Stock O'Higgins" },
  { key: "stock_gpz", label: "Stock General Paz" },
];

// Las planillas reales traen cabeceras con acentos, puntos y abreviaturas
// ("Código", "P. Unit s/IVA", "Stock O'Higgins"). Normalizamos y probamos
// varios sinónimos por campo en vez de exigir que la cabecera contenga la clave.
const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// N\u00fameros que pueden venir en formato argentino ("1.234,56": punto miles, coma
// decimal) o ingl\u00e9s/datos ("1234.56": punto decimal). Reglas:
//  - Si hay coma: la coma es el decimal y los puntos (si hay) son miles.
//  - Si NO hay coma y hay VARIOS puntos: son separadores de miles ("1.234.567").
//  - Si NO hay coma y hay UN solo punto: es el decimal y se respeta tal cual
//    ("224410.56" NO se convierte en 22441056). Antes se lo trataba como miles
//    cuando ten\u00eda 3 d\u00edgitos, lo que corromp\u00eda precios de lista con muchos decimales.
function parseNumAr(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (s === "") return NaN;
  const puntos = (s.match(/\./g) || []).length;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (puntos > 1) {
    s = s.replace(/\./g, "");
  }
  return Number(s);
}
// parseNumAr con valor por defecto cuando la celda est\u00e1 vac\u00eda o no es un n\u00famero.
const numOr = (v: unknown, def: number) => {
  const n = parseNumAr(v);
  return Number.isFinite(n) ? n : def;
};

const sinonimos: Record<string, string[]> = {
  codigo: ["codigo", "cod", "sku", "articulo"],
  nombre: ["nombre", "descripcion", "detalle", "producto"],
  precio_lista: ["preciodelista", "preciolista", "listadeprecios", "listaprecios", "lista"],
  precio_fabrica: ["preciofabrica", "fabrica", "costo", "preciocosto"],
  precio_sin_iva: ["preciosiniva", "preciosiva", "preciounitario", "precioneto", "precio", "punit"],
  iva_porcentaje: ["iva", "alicuota", "ivaporcentaje"],
  stock_minimo: ["stockminimo", "minimo", "stockmin"],
  tamano_envase: ["env", "envase", "tamanoenvase", "tamano", "presentacion", "capacidad"],
  unidad_medida: ["unidad", "unidadmedida", "um", "medida"],
  categoria: ["categoria", "rubro"],
  marca: ["marca", "fabricante"],
  stock_ohi: ["stockohiggins", "ohiggins", "ohi", "stockohi"],
  stock_gpz: ["stockgeneralpaz", "generalpaz", "gpz", "stockgpz"],
};

// Parsea una hoja detectando la fila de encabezados: en las listas reales el
// título ("LISTA DE PRECIOS N° ...") ocupa las primeras filas y los encabezados
// (CÓDIGO, DESCRIPCIÓN, PRECIO DE LISTA) están más abajo. Buscamos la primera fila
// que contenga alguna de esas claves y la usamos como header.
function parsearHoja(ws: any): { rows: Row[]; headers: string[] } {
  const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: "" });
  const claves = ["codigo", "descripcion", "denominacion", "precio", "nombre"];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const celdas = (aoa[i] || []).map((c: any) => normalizar(String(c)));
    if (celdas.filter((c: string) => claves.some((k) => c.includes(k))).length >= 2) { headerIdx = i; break; }
  }
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { range: headerIdx, defval: "" });
  const headers = Object.keys(rows[0] ?? {});
  return { rows, headers };
}

function autoMapear(headers: string[]): Record<string, string> {
  const auto: Record<string, string> = {};
  const usados = new Set<string>();
  for (const t of fieldsTarget) {
    const candidatos = sinonimos[t.key] ?? [t.key];
    // Coincidencia exacta primero; si no, la cabecera que contenga el sinónimo.
    const exacto = headers.find((h) => !usados.has(h) && candidatos.includes(normalizar(h)));
    let parcial =
      exacto ??
      headers.find((h) => !usados.has(h) && candidatos.some((c) => normalizar(h).includes(c)));
    // El % de IVA no debe engancharse a una columna de PRECIO que contenga "c/iva"
    // (ej "Sugerido al público C/IVA"): sus valores romperían numeric(5,2).
    if (parcial && exacto == null && t.key === "iva_porcentaje" &&
        /precio|sugerido|publico|venta|costo|importe/.test(normalizar(parcial))) {
      parcial = undefined;
    }
    if (parcial) {
      auto[t.key] = parcial;
      usados.add(parcial);
    }
  }
  return auto;
}

function ImportarProductos() {
  const navigate = useNavigate();
  const { data: cu } = useCurrentUser();
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Array<{ row:number; msg:string }>>([]);
  const [wb, setWb] = useState<any>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetSel, setSheetSel] = useState<string>("");
  // Parámetros de precio (se inicializan desde settings y se guardan al importar).
  const [descuento, setDescuento] = useState<number>(42);
  const [markupDef, setMarkupDef] = useState<number>(50);
  useEffect(() => {
    supabase.from("settings").select("markup_default_porcentaje, descuento_proveedor_porcentaje").maybeSingle()
      .then(({ data }) => {
        if (data?.descuento_proveedor_porcentaje != null) setDescuento(Number(data.descuento_proveedor_porcentaje));
        if (data?.markup_default_porcentaje != null) setMarkupDef(Number(data.markup_default_porcentaje));
      });
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
        setWb(null); setSheetNames([]);
        const parsed = Papa.parse<Row>(data as string, { header: true, skipEmptyLines: true });
        aplicarDatos(parsed.data, parsed.meta.fields ?? []);
      } else {
        // El Excel de Quimex tiene varias solapas (la que sirve es "LISTA PLANA").
        // Guardamos el libro y dejamos elegir la solapa; así se sube el archivo
        // ORIGINAL sin re-guardarlo (re-guardarlo en Excel-es corrompe los decimales).
        const wbk = XLSX.read(data, { type: "binary" });
        setWb(wbk); setSheetNames(wbk.SheetNames);
        // Elegimos por defecto una solapa "plana" si existe; si no, la primera.
        const plana = wbk.SheetNames.find((n: string) => normalizar(n).includes("plana")) ?? wbk.SheetNames[0];
        procesarSolapa(wbk, plana);
      }
    };
    if (ext === "csv") reader.readAsText(f);
    else reader.readAsBinaryString(f);
  };

  const confirmar = async () => {
    setBusy(true);
    const errs: Array<{ row:number; msg:string }> = [];
    // Cache categorías/marcas
    const { data: cats = [] } = await supabase.from("categorias").select("*");
    const { data: mks = [] } = await supabase.from("marcas").select("*");
    const { data: sucs = [] } = await supabase.from("sucursales").select("id, codigo");
    // Parámetros de precio elegidos en la UI; se persisten para próximas importaciones.
    const markupDefault = Number(markupDef) || 50;
    const descuentoProveedor = Number(descuento) || 0;
    // Persistir estos parámetros como default global es una escritura admin-only
    // (RLS: solo is_admin puede tocar settings). Un empleado igual puede importar
    // usando los valores de la pantalla; simplemente no los guarda como default,
    // así evitamos disparar un PATCH que la RLS rechazaría con 403.
    if (cu?.isAdmin) {
      await supabase.from("settings").update({
        markup_default_porcentaje: markupDefault, descuento_proveedor_porcentaje: descuentoProveedor,
      }).eq("id", true);
    }
    const sucMap = new Map((sucs ?? []).map((s:any) => [s.codigo, s.id]));
    const catMap = new Map((cats ?? []).map((c:any) => [c.nombre.toLowerCase(), c.id]));
    const mkMap = new Map((mks ?? []).map((m:any) => [m.nombre.toLowerCase(), m.id]));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const codigo = String(r[mapping.codigo] ?? "").trim();
        const nombre = String(r[mapping.nombre] ?? "").trim();
        if (!codigo || !nombre) { errs.push({ row: i+2, msg: "Falta código o nombre" }); continue; }

        // Cat / marca
        let cat_id = null, mk_id = null;
        if (mapping.categoria) {
          const v = String(r[mapping.categoria] ?? "").trim();
          if (v) {
            cat_id = catMap.get(v.toLowerCase());
            if (!cat_id) {
              const { data } = await supabase.from("categorias").insert({ nombre: v }).select().single();
              cat_id = data?.id; if (cat_id) catMap.set(v.toLowerCase(), cat_id);
            }
          }
        }
        if (mapping.marca) {
          const v = String(r[mapping.marca] ?? "").trim();
          if (v) {
            mk_id = mkMap.get(v.toLowerCase());
            if (!mk_id) {
              const { data } = await supabase.from("marcas").insert({ nombre: v }).select().single();
              mk_id = data?.id; if (mk_id) mkMap.set(v.toLowerCase(), mk_id);
            }
          }
        }

        // Cadena de precios (misma que la pantalla de Productos):
        //   precio_lista (Quimex) × (1 − descuento) = precio_fabrica (costo)
        //   precio_fabrica × (1 + markup)           = precio_sin_iva (venta)
        // Si la planilla trae el precio de lista, se deriva el costo con el descuento
        // del proveedor. Si no, se usa el precio de fábrica de la planilla. El precio
        // s/IVA se respeta si viene explícito; si no, se deriva con el markup default.
        const precioLista = mapping.precio_lista ? numOr(r[mapping.precio_lista], 0) : 0;
        const precioFabrica = mapping.precio_lista && precioLista > 0
          ? +(precioLista * (1 - descuentoProveedor / 100)).toFixed(2)
          : (mapping.precio_fabrica ? numOr(r[mapping.precio_fabrica], 0) : 0);
        const precioSinIvaPlanilla = mapping.precio_sin_iva ? parseNumAr(r[mapping.precio_sin_iva]) : NaN;
        const precioSinIva = Number.isFinite(precioSinIvaPlanilla) && precioSinIvaPlanilla > 0
          ? precioSinIvaPlanilla
          : +(precioFabrica * (1 + markupDefault / 100)).toFixed(2);

        // Un valor absurdo (típicamente el separador decimal mal interpretado: un
        // Excel en español que lee "2136004.80" como 213600480) daría el críptico
        // "numeric field overflow" de Postgres. Lo atajamos con un mensaje claro.
        const LIMITE = 999_999_999; // ningún precio de pinturería llega a mil millones
        for (const [campo, val, raw] of ([
          ["precio de lista", precioLista, mapping.precio_lista ? r[mapping.precio_lista] : ""],
          ["precio de fábrica", precioFabrica, mapping.precio_fabrica ? r[mapping.precio_fabrica] : ""],
          ["precio s/IVA", precioSinIva, mapping.precio_sin_iva ? r[mapping.precio_sin_iva] : ""],
        ] as [string, number, unknown][])) {
          if (val > LIMITE) {
            throw new Error(`El ${campo} (${raw || val}) parece mal formateado. Suele pasar al abrir el Excel de Quimex en Excel con configuración argentina, que interpreta el punto decimal como separador de miles. Subí el archivo original sin re-guardarlo, o revisá el separador decimal.`);
          }
        }

        const payload = {
          codigo, nombre,
          categoria_id: cat_id ?? null, marca_id: mk_id ?? null,
          unidad_medida: String(r[mapping.unidad_medida] ?? "unidad") || "unidad",
          precio_lista: +precioLista.toFixed(2),
          precio_fabrica: precioFabrica,
          precio_sin_iva: precioSinIva,
          // Un IVA fuera de [0,100] es un mapeo/valor equivocado (típico: se mapeó una
          // columna de precio "C/IVA" al % de IVA). Se ignora y se usa el default.
          iva_porcentaje: (() => { const x = numOr(r[mapping.iva_porcentaje], 21); return x >= 0 && x <= 100 ? x : 21; })(),
          stock_minimo: numOr(r[mapping.stock_minimo], 0),
          // R8: tamaño de envase (ENV). Vacío -> null (no todo producto lo trae).
          tamano_envase: (() => { const n = parseNumAr(mapping.tamano_envase ? r[mapping.tamano_envase] : ""); return Number.isFinite(n) ? n : null; })(),
        };
        const { data: up, error } = await supabase.from("productos")
          .upsert(payload, { onConflict: "codigo" }).select().single();
        if (error) throw error;

        // Stock por sucursal
        const stockOhi = numOr(r[mapping.stock_ohi], 0);
        const stockGpz = numOr(r[mapping.stock_gpz], 0);
        if (mapping.stock_ohi && sucMap.get("OHIGGINS")) {
          await supabase.from("stock_sucursal").upsert({
            producto_id: up.id, sucursal_id: sucMap.get("OHIGGINS"), cantidad: stockOhi,
          }, { onConflict: "producto_id,sucursal_id" });
        }
        if (mapping.stock_gpz && sucMap.get("GENERALPAZ")) {
          await supabase.from("stock_sucursal").upsert({
            producto_id: up.id, sucursal_id: sucMap.get("GENERALPAZ"), cantidad: stockGpz,
          }, { onConflict: "producto_id,sucursal_id" });
        }
      } catch (e:any) {
        errs.push({ row: i+2, msg: e.message });
      }
    }
    setBusy(false); setErrors(errs);
    if (errs.length === 0) {
      toast.success(`${rows.length} productos importados`);
      navigate({ to: "/productos" });
    } else {
      toast.warning(`Importación con ${errs.length} errores. Revisá el detalle abajo.`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={()=>navigate({ to: "/productos" })}><ArrowLeft className="h-4 w-4"/></Button>
        <h1 className="text-2xl font-bold">Importar productos</h1>
      </div>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Subí el Excel de Quimex <strong>tal cual</strong> (.xlsx) o un CSV. Si es el Excel de Quimex, elegí la solapa
          <strong> LISTA PLANA</strong>. Evitá abrirlo y re-guardarlo antes de subirlo: puede corromper los decimales.
        </p>
        <Input type="file" accept=".xlsx,.xls,.csv" onChange={(e)=>e.target.files?.[0] && handleFile(e.target.files[0])}/>
        {sheetNames.length > 1 && (
          <div className="max-w-xs">
            <Label>Solapa del Excel</Label>
            <Select value={sheetSel} onValueChange={(v) => wb && procesarSolapa(wb, v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{sheetNames.map((n) => (<SelectItem key={n} value={n}>{n}</SelectItem>))}</SelectContent>
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
                <Input type="number" value={descuento} onChange={(e) => setDescuento(Number(e.target.value))} />
                <p className="text-[11px] text-muted-foreground mt-1">El costo se calcula como precio de lista − este %.</p>
              </div>
              <div>
                <Label>Markup default %</Label>
                <Input type="number" value={markupDef} onChange={(e) => setMarkupDef(Number(e.target.value))} />
                <p className="text-[11px] text-muted-foreground mt-1">Se aplica al costo para el precio de venta (si el producto no tiene markup propio).</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Mapeo de columnas</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {fieldsTarget.map(f => (
                <div key={f.key}>
                  <Label>{f.label}</Label>
                  <Select value={mapping[f.key] ?? "__none__"} onValueChange={(v)=>setMapping(m=>({ ...m, [f.key]: v==="__none__" ? "" : v }))}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— (sin mapear)</SelectItem>
                      {headers.map(h => (<SelectItem key={h} value={h}>{h}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="font-semibold mb-3">Vista previa ({rows.length} filas)</h3>
            <div className="max-h-64 overflow-auto text-xs">
              <Table>
                <TableHeader><TableRow>{headers.map(h=>(<TableHead key={h}>{h}</TableHead>))}</TableRow></TableHeader>
                <TableBody>
                  {rows.slice(0,10).map((r,i)=>(
                    <TableRow key={i}>{headers.map(h=>(<TableCell key={h}>{String(r[h] ?? "")}</TableCell>))}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Button className="mt-3" onClick={confirmar} disabled={busy || !mapping.codigo || !mapping.nombre}>
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1"/>}
              Confirmar importación
            </Button>
            {!mapping.codigo || !mapping.nombre ? <p className="text-xs text-muted-foreground mt-2">Mapeá al menos Código y Nombre.</p> : null}
          </Card>

          {errors.length > 0 && (
            <Card className="p-4 border-destructive/40">
              <h3 className="font-semibold text-destructive mb-2">Errores ({errors.length})</h3>
              <ul className="text-xs space-y-1 max-h-48 overflow-auto">
                {errors.map((e,i)=>(<li key={i}>Fila {e.row}: {e.msg}</li>))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
