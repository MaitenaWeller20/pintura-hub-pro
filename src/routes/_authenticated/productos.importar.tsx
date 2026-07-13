import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/productos/importar")({
  component: ImportarProductos,
});

type Row = Record<string, any>;
const fieldsTarget = [
  { key: "codigo", label: "Código *" },
  { key: "nombre", label: "Nombre *" },
  { key: "precio_fabrica", label: "Precio fábrica" },
  { key: "precio_sin_iva", label: "Precio s/IVA" },
  { key: "iva_porcentaje", label: "IVA %" },
  { key: "stock_minimo", label: "Stock mínimo" },
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

const sinonimos: Record<string, string[]> = {
  codigo: ["codigo", "cod", "sku", "articulo"],
  nombre: ["nombre", "descripcion", "detalle", "producto"],
  precio_fabrica: ["preciofabrica", "fabrica", "costo", "preciocosto"],
  precio_sin_iva: ["preciosiniva", "preciosiva", "preciounitario", "precioneto", "precio", "punit"],
  iva_porcentaje: ["iva", "alicuota", "ivaporcentaje"],
  stock_minimo: ["stockminimo", "minimo", "stockmin"],
  unidad_medida: ["unidad", "unidadmedida", "um", "medida"],
  categoria: ["categoria", "rubro"],
  marca: ["marca", "fabricante"],
  stock_ohi: ["stockohiggins", "ohiggins", "ohi", "stockohi"],
  stock_gpz: ["stockgeneralpaz", "generalpaz", "gpz", "stockgpz"],
};

function autoMapear(headers: string[]): Record<string, string> {
  const auto: Record<string, string> = {};
  const usados = new Set<string>();
  for (const t of fieldsTarget) {
    const candidatos = sinonimos[t.key] ?? [t.key];
    // Coincidencia exacta primero; si no, la cabecera que contenga el sinónimo.
    const exacto = headers.find((h) => !usados.has(h) && candidatos.includes(normalizar(h)));
    const parcial =
      exacto ??
      headers.find((h) => !usados.has(h) && candidatos.some((c) => normalizar(h).includes(c)));
    if (parcial) {
      auto[t.key] = parcial;
      usados.add(parcial);
    }
  }
  return auto;
}

function ImportarProductos() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Array<{ row:number; msg:string }>>([]);

  const handleFile = (f: File) => {
    setErrors([]);
    const ext = f.name.split(".").pop()?.toLowerCase();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target?.result;
      let parsedRows: Row[] = [];
      let parsedHeaders: string[] = [];
      if (ext === "csv") {
        const parsed = Papa.parse<Row>(data as string, { header: true, skipEmptyLines: true });
        parsedRows = parsed.data;
        parsedHeaders = parsed.meta.fields ?? [];
      } else {
        const wb = XLSX.read(data, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        parsedRows = XLSX.utils.sheet_to_json<Row>(ws, { defval: "" });
        parsedHeaders = Object.keys(parsedRows[0] ?? {});
      }
      setRows(parsedRows);
      setHeaders(parsedHeaders);
      setMapping(autoMapear(parsedHeaders));
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
    const { data: settings } = await supabase.from("settings").select("markup_default_porcentaje").maybeSingle();
    const markupDefault = Number(settings?.markup_default_porcentaje ?? 50);
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

        // Precio de venta: si la planilla trae precio s/IVA se respeta; si sólo trae
        // precio de fábrica, se deriva aplicando el markup default (fábrica × (1 + %)),
        // que es el mismo modelo de precios que usa la pantalla de Productos.
        const precioFabrica = mapping.precio_fabrica ? Number(r[mapping.precio_fabrica] ?? 0) : 0;
        const precioSinIvaPlanilla = mapping.precio_sin_iva ? Number(r[mapping.precio_sin_iva] ?? 0) : NaN;
        const precioSinIva = Number.isFinite(precioSinIvaPlanilla) && precioSinIvaPlanilla > 0
          ? precioSinIvaPlanilla
          : +(precioFabrica * (1 + markupDefault / 100)).toFixed(2);

        const payload = {
          codigo, nombre,
          categoria_id: cat_id ?? null, marca_id: mk_id ?? null,
          unidad_medida: String(r[mapping.unidad_medida] ?? "unidad") || "unidad",
          precio_fabrica: precioFabrica,
          precio_sin_iva: precioSinIva,
          iva_porcentaje: Number(r[mapping.iva_porcentaje] ?? 21),
          stock_minimo: Number(r[mapping.stock_minimo] ?? 0),
        };
        const { data: up, error } = await supabase.from("productos")
          .upsert(payload, { onConflict: "codigo" }).select().single();
        if (error) throw error;

        // Stock por sucursal
        const stockOhi = Number(r[mapping.stock_ohi] ?? 0);
        const stockGpz = Number(r[mapping.stock_gpz] ?? 0);
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
        <p className="text-sm text-muted-foreground">Subí un archivo Excel (.xlsx) o CSV. Luego mapeá las columnas a los campos del sistema.</p>
        <Input type="file" accept=".xlsx,.xls,.csv" onChange={(e)=>e.target.files?.[0] && handleFile(e.target.files[0])}/>
      </Card>

      {rows.length > 0 && (
        <>
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
