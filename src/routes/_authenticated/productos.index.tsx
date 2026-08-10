import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { traerTodo } from "@/lib/supabase-paginado";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney } from "@/lib/format";
import {
  MARKUP_DEFAULT,
  OPERACION_LABEL,
  ORIGEN_AYUDA,
  ORIGEN_LABEL,
  type OperacionPrecio,
  type OrigenPrecio,
  baseDelPrecio,
  calcularPrecios,
  coincideConFormula,
  costoDeLista,
  descuentoEfectivo,
  simularOperacion,
} from "@/lib/precios";
import { activables, motivoNoActivar, type ProductoActivable } from "@/lib/productos-activar";
import { uuidv4 } from "@/lib/uuid";
import { toast } from "sonner";
import {
  Plus,
  Upload,
  Pencil,
  Printer,
  Percent,
  Power,
  Trash2,
  ArchiveRestore,
  History,
} from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { useServerFn } from "@tanstack/react-start";
import { activarProductos, eliminarProductos, restaurarProductos } from "@/lib/productos.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/productos/")({
  component: Productos,
});

// La cadena de precios vive en @/lib/precios. Hasta el 29/07/2026 esta pantalla
// tenía su propia copia (calcPrecio/costoDeLista), igual que la importación y el
// markup masivo: tres fórmulas que se desincronizaban.
const ORIGEN_TONO: Record<OrigenPrecio, string> = {
  sugerido: "border-success/40 text-success",
  costo: "border-border text-muted-foreground",
  manual: "border-warning/50 text-warning",
};

/** Los campos de un producto que `vista` necesita para armar la fila de precios. */
type ProductoFila = {
  precio_sin_iva: number;
  iva_porcentaje: number;
  precio_fabrica?: number | null;
  precio_lista?: number | null;
  precio_sugerido_publico?: number | null;
  markup_porcentaje?: number | null;
};

function Productos() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [provFilter, setProvFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [openMarkup, setOpenMarkup] = useState(false);
  const [verArchivados, setVerArchivados] = useState(false);
  // "Sin precio o apagados": los que la importación de stock dio de alta para que
  // el inventario cuadre. Están mezclados entre ~1800 y la única señal era un
  // cartelito gris en la fila, así que encontrarlos era imposible.
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [aEliminar, setAEliminar] = useState<any[] | null>(null); // productos a confirmar eliminación
  const eliminarFn = useServerFn(eliminarProductos);
  const restaurarFn = useServerFn(restaurarProductos);
  const activarFn = useServerFn(activarProductos);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await supabase.from("settings").select("*").maybeSingle()).data,
  });
  const markupDefault = Number(settings?.markup_default_porcentaje ?? MARKUP_DEFAULT);
  const descuentoProveedor = Number(settings?.descuento_proveedor_porcentaje ?? 42);

  // Paginado explícito: PostgREST corta en 1000 filas sin avisar, así que esta
  // pantalla mostraba "1000 de 1000" teniendo 1133 productos. El orden tiene que
  // ser total (`nombre` no es único) o la paginación por offset saltea/repite.
  const { data: productos = [] } = useQuery({
    queryKey: ["productos"],
    queryFn: async () => {
      const { filas } = await traerTodo<any>(async (desde, hasta) => {
        const { data, error, count } = await supabase
          .from("productos")
          .select(
            "*, categoria:categorias(id,nombre), marca:marcas(id,nombre), proveedor:proveedores(id,razon_social,descuento_porcentaje)",
            { count: "exact" },
          )
          .order("nombre")
          .order("id")
          .range(desde, hasta);
        return { data, error, count };
      });
      return filas;
    },
  });
  const { data: categorias = [] } = useQuery({
    queryKey: ["categorias"],
    queryFn: async () =>
      ((await supabase.from("categorias").select("*").order("nombre")).data ?? []) as any[],
  });
  const { data: proveedores = [] } = useQuery({
    queryKey: ["proveedores"],
    queryFn: async () =>
      ((
        await supabase
          .from("proveedores")
          .select("id, razon_social, descuento_porcentaje")
          .order("razon_social")
      ).data ?? []) as any[],
  });
  const { data: marcas = [] } = useQuery({
    queryKey: ["marcas"],
    queryFn: async () =>
      ((await supabase.from("marcas").select("*").order("nombre")).data ?? []) as any[],
  });

  const filtered = useMemo(
    () =>
      productos.filter((p: any) => {
        // Los archivados se ocultan salvo que se active "ver archivados".
        if (!verArchivados && p.archivado) return false;
        if (verArchivados && !p.archivado) return false;
        // Falta algo para poder venderlo: o no tiene precio, o está apagado.
        if (soloPendientes && !(Number(p.precio_sin_iva ?? 0) <= 0 || !p.activo)) return false;
        if (catFilter !== "all" && p.categoria_id !== catFilter) return false;
        // "sin" encuentra los que quedaron sin etiquetar; si no, son invisibles.
        if (provFilter === "sin" && p.proveedor_id != null) return false;
        if (provFilter !== "all" && provFilter !== "sin" && p.proveedor_id !== provFilter)
          return false;
        if (
          q &&
          !`${p.codigo} ${p.nombre} ${p.marca?.nombre ?? ""}`
            .toLowerCase()
            .includes(q.toLowerCase())
        )
          return false;
        return true;
      }),
    [productos, q, catFilter, provFilter, verArchivados, soloPendientes],
  );

  /** Cuántos no se pueden vender todavía. Se muestra sólo si hay. */
  const pendientes = useMemo(
    () =>
      productos.filter(
        (p: any) => !p.archivado && (Number(p.precio_sin_iva ?? 0) <= 0 || !p.activo),
      ).length,
    [productos],
  );

  /**
   * Qué haría el botón "Activar" con lo tildado. Sale de `productos` y no de
   * `filtered` —igual que "Eliminar seleccionados"— para que escribir algo en el
   * buscador no saltee en silencio un producto que quedó tildado y fuera de vista.
   * Estos números son para el botón; los que se le informan al final salen de la
   * RPC, que es la que sabe cómo está la base en el momento del click.
   */
  const reparto = useMemo(
    () => activables(productos.filter((p: ProductoActivable) => seleccion.has(p.id))),
    [productos, seleccion],
  );

  const toggleSel = (id: string) =>
    setSeleccion((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSeleccion((s) =>
      s.size === filtered.length ? new Set() : new Set(filtered.map((p: any) => p.id)),
    );

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["productos"] });
    setSeleccion(new Set());
  };

  const eliminarM = useMutation({
    mutationFn: async (ids: string[]) => await eliminarFn({ data: { ids } }),
    onSuccess: (r) => {
      const partes = [];
      if (r.borrados.length)
        partes.push(`${r.borrados.length} eliminado${r.borrados.length > 1 ? "s" : ""}`);
      if (r.archivados.length)
        partes.push(
          `${r.archivados.length} archivado${r.archivados.length > 1 ? "s" : ""} (tenían historial o stock)`,
        );
      if (r.bloqueados.length)
        partes.push(
          `${r.bloqueados.length} en borrador (saltado${r.bloqueados.length > 1 ? "s" : ""})`,
        );
      toast.success(partes.join(" · ") || "Sin cambios");
      setAEliminar(null);
      refrescar();
    },
    onError: (e: any) => {
      toast.error(e.message);
      setAEliminar(null);
    },
  });

  const restaurarM = useMutation({
    mutationFn: async (ids: string[]) => await restaurarFn({ data: { ids } }),
    onSuccess: (r) => {
      toast.success(`${r.restaurados} restaurado${r.restaurados !== 1 ? "s" : ""}`);
      refrescar();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const activarM = useMutation({
    mutationFn: async (ids: string[]) => await activarFn({ data: { ids } }),
    onSuccess: (r) => {
      // Los saltados se dicen SIEMPRE. Prender 3 de 500 y mostrar sólo el 3 deja
      // a la clienta creyendo que ya puede vender los otros 497.
      const saltados = [];
      if (r.sin_precio) saltados.push(`${r.sin_precio} sin precio (saltados)`);
      if (r.archivados) saltados.push(`${r.archivados} archivados (restauralos primero)`);
      // Que no se haya prendido ninguno no es un éxito: hay que decir qué falta.
      if (r.activados === 0) {
        toast.error(
          saltados.length
            ? `Ninguno se pudo prender · ${saltados.join(" · ")}`
            : // Pasa sin que nadie se equivoque: otro usuario los prendió mientras
              // esta lista estaba dibujada.
              "Ninguno se pudo prender: ya estaban activos.",
        );
      } else {
        toast.success(
          [`${r.activados} activado${r.activados !== 1 ? "s" : ""}`, ...saltados].join(" · "),
        );
      }
      refrescar();
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Las exportaciones llevan la cadena completa (incluido el neto y el IVA, que
  // la tabla ya no muestra para que entre en pantalla).
  const vista = (p: ProductoFila) => {
    const sIva = Number(p.precio_sin_iva);
    const iva = Number(p.iva_porcentaje);
    return {
      mk: p.markup_porcentaje ?? markupDefault,
      sIva,
      cIva: +(sIva * (1 + iva / 100)).toFixed(2),
      costo: Number(p.precio_fabrica ?? 0),
      costoCIva: +(Number(p.precio_fabrica ?? 0) * (1 + iva / 100)).toFixed(2),
      lista: Number(p.precio_lista ?? 0),
      sugerido: p.precio_sugerido_publico == null ? null : Number(p.precio_sugerido_publico),
      origen: baseDelPrecio(p),
      coincide: coincideConFormula(p, { markupDefault }),
    };
  };

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((p: any) => {
        const v = vista(p);
        return {
          Código: p.codigo,
          Nombre: p.nombre,
          Categoría: p.categoria?.nombre,
          Marca: p.marca?.nombre,
          Unidad: p.unidad_medida,
          "Precio de lista": v.lista,
          "Precio Fábrica": v.costo,
          "Costo c/IVA": v.costoCIva,
          "Sugerido al público": v.sugerido ?? "",
          "% Markup": v.mk,
          "Precio s/IVA": v.sIva,
          "IVA %": p.iva_porcentaje,
          "Precio c/IVA": v.cIva,
          "Origen del precio": ORIGEN_LABEL[v.origen],
          "Stock mín.": p.stock_minimo,
          Activo: p.activo,
        };
      }),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Productos");
    XLSX.writeFile(wb, "productos.xlsx");
  };

  const imprimir = () => {
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text("CasaForma — Listado de productos", 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [
        [
          "Código",
          "Nombre",
          "Marca",
          "Lista",
          "Costo",
          "Costo c/IVA",
          "Sugerido",
          "%",
          "P.s/IVA",
          "IVA",
          "Venta c/IVA",
        ],
      ],
      body: filtered.map((p: any) => {
        const v = vista(p);
        return [
          p.codigo,
          p.nombre,
          p.marca?.nombre ?? "",
          v.lista ? fmtMoney(v.lista) : "—",
          fmtMoney(v.costo),
          fmtMoney(v.costoCIva),
          v.sugerido ? fmtMoney(v.sugerido) : "—",
          `${v.mk}%`,
          fmtMoney(v.sIva),
          `${p.iva_porcentaje}%`,
          fmtMoney(v.cIva),
        ];
      }),
      styles: { fontSize: 7 },
    });
    doc.save("productos.pdf");
  };

  if (!cu) return null;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Productos"
        subtitle={
          <>
            {filtered.length} de {productos.length} · Markup por defecto:{" "}
            <strong>{markupDefault}%</strong>
            {seleccion.size > 0 && <> · {seleccion.size} seleccionados</>}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={imprimir}>
              <Printer className="h-4 w-4 mr-1" /> PDF
            </Button>
            <Button variant="outline" onClick={exportar}>
              <Upload className="h-4 w-4 mr-1" /> Excel
            </Button>
            {cu.isAdmin && (
              <>
                {/* Sólo si hay algo apagado que prender: un botón que está
                    siempre y casi nunca hace nada es ruido. */}
                {reparto.apagados > 0 && !verArchivados && (
                  <Button
                    variant="outline"
                    className="text-success"
                    data-testid="activar-masivo"
                    disabled={activarM.isPending}
                    // El motivo se arma con lo que hay de verdad: decir "sin
                    // precio" cuando en realidad están archivados manda a arreglar
                    // lo que no es.
                    title={
                      reparto.prender.length
                        ? "Pone en venta los productos apagados que ya tienen precio"
                        : reparto.sinPrecio
                          ? `Ninguno se puede prender: ${reparto.sinPrecio} de los seleccionados no tienen precio y se venderían a $0`
                          : "Ninguno se puede prender: están archivados, hay que restaurarlos primero"
                    }
                    // Se le manda la selección COMPLETA, no `reparto.prender`. La
                    // RPC es la que separa los que prende de los que salta, y es la
                    // única que sabe cómo está la base ahora; mandándole sólo los
                    // que se pueden prender, los saltados no existirían para ella y
                    // el cartel diría "3 activados" sin mencionar los otros 497.
                    // El botón no se muestra con la selección vacía, así que nunca
                    // llega un array vacío (la server fn exige al menos un id).
                    onClick={() => activarM.mutate(Array.from(seleccion))}
                  >
                    <Power className="h-4 w-4 mr-1" /> Activar ({reparto.prender.length})
                  </Button>
                )}
                {seleccion.size > 0 && !verArchivados && (
                  <Button
                    variant="outline"
                    className="text-destructive"
                    data-testid="eliminar-masivo"
                    onClick={() => setAEliminar(productos.filter((p: any) => seleccion.has(p.id)))}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Eliminar seleccionados ({seleccion.size})
                  </Button>
                )}
                {seleccion.size > 0 && verArchivados && (
                  <Button
                    variant="outline"
                    data-testid="restaurar-masivo"
                    onClick={() => restaurarM.mutate(Array.from(seleccion))}
                  >
                    <ArchiveRestore className="h-4 w-4 mr-1" /> Restaurar ({seleccion.size})
                  </Button>
                )}
                <Button variant="outline" onClick={() => setOpenMarkup(true)}>
                  <Percent className="h-4 w-4 mr-1" /> Cambiar precios
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/productos/importar">Importar</Link>
                </Button>
                <Button
                  onClick={() => {
                    setEditing(null);
                    setOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" /> Nuevo
                </Button>
              </>
            )}
          </>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2 items-center">
          <Input
            placeholder="Buscar por código, nombre o marca…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          <Select value={catFilter} onValueChange={setCatFilter}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las categorías</SelectItem>
              {categorias.map((c: any) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={provFilter} onValueChange={setProvFilter}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los proveedores</SelectItem>
              <SelectItem value="sin">Sin proveedor</SelectItem>
              {proveedores.map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.razon_social}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Sólo si hay alguno: un filtro que siempre da 0 es ruido. */}
          {pendientes > 0 && !verArchivados && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={soloPendientes}
                onCheckedChange={(v) => {
                  setSoloPendientes(!!v);
                  setSeleccion(new Set());
                }}
                data-testid="solo-pendientes"
              />
              Sin precio o apagados{" "}
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-xs text-warning">
                {pendientes}
              </span>
            </label>
          )}
          {cu.isAdmin && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer ml-auto">
              <Checkbox
                checked={verArchivados}
                onCheckedChange={(v) => {
                  setVerArchivados(!!v);
                  setSeleccion(new Set());
                  setSoloPendientes(false);
                }}
                data-testid="ver-archivados"
              />
              Ver archivados
            </label>
          )}
        </div>
      </SectionCard>

      <div className="rounded-2xl border border-border overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {cu.isAdmin && (
                  <TableHead className="w-8">
                    <Checkbox
                      checked={seleccion.size === filtered.length && filtered.length > 0}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                )}
                <TableHead>Código</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead className="text-right">Env.</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead className="text-right">Lista</TableHead>
                <TableHead className="text-right">Costo</TableHead>
                <TableHead className="text-right">Costo c/IVA</TableHead>
                <TableHead className="text-right">Sugerido</TableHead>
                <TableHead className="text-right">% Markup</TableHead>
                <TableHead className="text-right">Venta c/IVA</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p: any) => {
                const v = vista(p);
                return (
                  <TableRow key={p.id}>
                    {cu.isAdmin && (
                      <TableCell>
                        <Checkbox
                          checked={seleccion.has(p.id)}
                          onCheckedChange={() => toggleSel(p.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">{p.codigo}</TableCell>
                    <TableCell>
                      {p.nombre}
                      {p.archivado ? (
                        <span className="ml-2 align-middle">
                          <StatusPill tone="danger">Archivado</StatusPill>
                        </span>
                      ) : (
                        !p.activo && (
                          <span className="ml-2 align-middle">
                            <StatusPill tone="neutral">Inactivo</StatusPill>
                          </span>
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                      {p.tamano_envase ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {p.proveedor?.razon_social ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {v.lista ? fmtMoney(v.lista) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(v.costo)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {fmtMoney(v.costoCIva)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {v.sugerido ? fmtMoney(v.sugerido) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {v.mk}%{" "}
                      {p.markup_porcentaje == null && (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          def
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold whitespace-nowrap">
                      {fmtMoney(v.cIva)}
                      {/* El IVA ya no tiene columna propia (no entraba), pero un
                          producto mal seteado en 10,5% o Exento es lo que se le
                          factura a AFIP: si no es 21%, se muestra acá para que se
                          vea de una. */}
                      {Number(p.iva_porcentaje) !== 21 && (
                        <Badge
                          variant="outline"
                          className="ml-1 text-[10px] font-sans border-warning/50 text-warning"
                          title="Este producto no tiene IVA 21%. Es la alícuota que se le va a facturar a AFIP."
                        >
                          IVA {p.iva_porcentaje}%
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className={`ml-1 text-[10px] font-sans ${ORIGEN_TONO[v.origen]}`}
                        title={ORIGEN_AYUDA[v.origen]}
                      >
                        {ORIGEN_LABEL[v.origen]}
                      </Badge>
                      {!v.coincide && v.origen !== "manual" && (
                        <Badge
                          variant="outline"
                          className="ml-1 text-[10px] font-sans border-border text-muted-foreground"
                          title={`El precio guardado no es el que da la fórmula hoy (markup ${markupDefault}%). Puede estar puesto a mano, o calculado con un markup anterior. "Aplicar markup" lo recalcula.`}
                        >
                          ≠
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Ver la historia de este producto"
                          asChild
                        >
                          <Link to="/productos/$id/seguimiento" params={{ id: p.id }}>
                            <History className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                        {cu.isAdmin && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(p);
                                setOpen(true);
                              }}
                              title="Editar"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {p.archivado ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Restaurar"
                                data-testid={`restaurar-${p.codigo}`}
                                onClick={() => restaurarM.mutate([p.id])}
                              >
                                <ArchiveRestore className="h-3.5 w-3.5 text-success" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Eliminar"
                                data-testid={`eliminar-${p.codigo}`}
                                onClick={() => setAEliminar([p])}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <ProductoDialog
        key={`${editing?.id ?? "nuevo"}-${open}`}
        open={open}
        onClose={() => setOpen(false)}
        editing={editing}
        categorias={categorias}
        marcas={marcas}
        markupDefault={markupDefault}
        descuentoProveedor={descuentoProveedor}
        proveedores={proveedores}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["productos"] });
          setOpen(false);
        }}
      />

      <PreciosDialog
        open={openMarkup}
        onClose={() => setOpenMarkup(false)}
        productosSel={filtered.filter((p: any) => seleccion.has(p.id))}
        totalFiltrado={filtered.length}
        markupDefault={markupDefault}
        descuentoGlobal={descuentoProveedor}
        onApplyAll={() => setSeleccion(new Set(filtered.map((p: any) => p.id)))}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["productos"] });
          qc.invalidateQueries({ queryKey: ["settings"] });
          setOpenMarkup(false);
          setSeleccion(new Set());
        }}
      />

      <AlertDialog open={!!aEliminar} onOpenChange={(v) => !v && setAEliminar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Eliminar {aEliminar?.length === 1 ? "producto" : `${aEliminar?.length} productos`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Los productos sin historial ni stock se <strong>borran</strong>. Los que tengan
              ventas, compras, movimientos o stock se <strong>archivan</strong> (se ocultan de las
              pantallas de trabajo, pero las facturas y reportes viejos quedan intactos). Los que
              estén en un ingreso en borrador se saltan. Esta acción se puede revertir restaurando
              desde "Ver archivados".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-eliminar"
              onClick={() => aEliminar && eliminarM.mutate(aEliminar.map((p) => p.id))}
              disabled={eliminarM.isPending}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProductoDialog({
  open,
  onClose,
  editing,
  categorias,
  marcas,
  proveedores,
  markupDefault,
  descuentoProveedor,
  onSaved,
}: any) {
  const [form, setForm] = useState<any>(
    () =>
      editing ?? {
        codigo: "",
        nombre: "",
        categoria_id: null,
        marca_id: null,
        proveedor_id: null,
        unidad_medida: "unidad",
        tamano_envase: null,
        precio_lista: 0,
        precio_fabrica: 0,
        descuento_porcentaje: null,
        precio_sugerido_publico: null,
        markup_porcentaje: null,
        precio_sin_iva: 0,
        iva_porcentaje: 21,
        stock_minimo: 0,
        activo: true,
      },
  );
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  // Aplica el cambio y recalcula el precio de venta con la cadena completa.
  // NO se le pasa precio_sin_iva a calcularPrecios: ese campo es el override
  // manual y, si se pasara, ganaría siempre y nada se recalcularía nunca.
  // El descuento que se usa para derivar el costo desde la lista sale de la
  // escalera completa: el del PRODUCTO si lo tiene, si no el de su PROVEEDOR, si
  // no el global. Sin el escalón del proveedor, cargar a mano un producto de un
  // proveedor con otro descuento le calculaba el costo con el de Quimex; sin el
  // del producto, no habría forma de que un renglón lleve un descuento distinto
  // al del resto de la lista.
  const descuentoDelProducto = descuentoEfectivo(
    form,
    proveedores?.find((x: any) => x.id === form.proveedor_id) ?? null,
    { descuento_proveedor_porcentaje: descuentoProveedor },
  );
  /** El que se aplicaría si el producto no tuviera el suyo. Es el placeholder. */
  const descuentoHeredado = descuentoEfectivo(
    null,
    proveedores?.find((x: any) => x.id === form.proveedor_id) ?? null,
    { descuento_proveedor_porcentaje: descuentoProveedor },
  );

  const recalcVenta = (patch: Record<string, any>) =>
    setForm((f: any) => {
      const next = { ...f, ...patch };
      const calc = calcularPrecios(
        {
          precio_fabrica: next.precio_fabrica,
          precio_sugerido_publico: next.precio_sugerido_publico,
          markup_porcentaje: next.markup_porcentaje,
          iva_porcentaje: next.iva_porcentaje,
        },
        { markupDefault },
      );
      // Sin sugerido ni costo la fórmula da 0, y pisar el precio con 0 dejaría al
      // producto vendiéndose gratis. Pasa de verdad: el alta rápida de Ingresos de
      // mercadería crea productos con el neto directo y el costo en 0, así que
      // abrir Editar y cambiar el IVA los ponía en $0 sin decir nada. Cuando no hay
      // de dónde calcular, el precio cargado queda como está.
      if (calc.precio_sin_iva <= 0) return next;
      return { ...next, precio_sin_iva: calc.precio_sin_iva };
    });

  // El invariante, del lado del editor: un producto activo a $0 se vende gratis.
  // Hasta el 10/08/2026 este diálogo lo permitía sin decir nada —un producto nuevo
  // arranca con `activo: true` y el precio en 0— así que un switch a secas no
  // alcanzaba. Es la misma cuenta que hace `crear_producto_desde_ingreso` en SQL
  // (`v_activo := v_precio > 0`).
  //
  // El switch muestra ESTO y no `form.activo`, para que lo que se ve sea lo que
  // queda guardado. Si no, un producto viejo activo a $0 mostraría el switch
  // prendido y se guardaría apagado.
  const activoGuardado = !!form.activo && Number(form.precio_sin_iva || 0) > 0;
  /** Por qué no se puede PRENDER. Apagar se puede siempre. */
  const motivoNo = motivoNoActivar(form);

  const m = useMutation({
    mutationFn: async () => {
      const payload = {
        codigo: form.codigo,
        nombre: form.nombre,
        categoria_id: form.categoria_id,
        marca_id: form.marca_id,
        proveedor_id: form.proveedor_id || null,
        unidad_medida: form.unidad_medida,
        tamano_envase:
          form.tamano_envase === null || form.tamano_envase === ""
            ? null
            : Number(form.tamano_envase),
        precio_lista: Number(form.precio_lista || 0),
        precio_fabrica: Number(form.precio_fabrica || 0),
        // Vacío = hereda. NO es lo mismo que 0, que significa "a esto no le
        // hacen descuento" y es un valor válido.
        descuento_porcentaje:
          form.descuento_porcentaje === null || form.descuento_porcentaje === ""
            ? null
            : Number(form.descuento_porcentaje),
        precio_sugerido_publico:
          form.precio_sugerido_publico === null || form.precio_sugerido_publico === ""
            ? null
            : Number(form.precio_sugerido_publico),
        markup_porcentaje:
          form.markup_porcentaje === null || form.markup_porcentaje === ""
            ? null
            : Number(form.markup_porcentaje),
        precio_sin_iva: Number(form.precio_sin_iva || 0),
        iva_porcentaje: Number(form.iva_porcentaje),
        stock_minimo: Number(form.stock_minimo || 0),
        activo: activoGuardado,
      };
      if (editing) {
        const { error } = await supabase.from("productos").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("productos").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Producto guardado");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const cIva = Number(form.precio_sin_iva || 0) * (1 + Number(form.iva_porcentaje || 0) / 100);
  // Lo que daría la fórmula, para poder avisar cuando el precio está puesto a mano.
  const calculado = calcularPrecios(
    {
      precio_fabrica: form.precio_fabrica,
      precio_sugerido_publico: form.precio_sugerido_publico,
      markup_porcentaje: form.markup_porcentaje,
      iva_porcentaje: form.iva_porcentaje,
    },
    { markupDefault },
  );
  // Sólo tiene sentido avisar "está a mano" si hay una fórmula con la que
  // compararlo. En un producto nuevo (todo en cero) el aviso decía "la fórmula
  // daría $0", que no le sirve a nadie.
  const esManual =
    Number(form.precio_sin_iva || 0) > 0 &&
    calculado.precio_sin_iva > 0 &&
    !coincideConFormula(form, { markupDefault });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* max-h + scroll: este diálogo mide ~900px y `DialogContent` no scrollea
          (es `fixed` y centrado, así que la página tampoco lo alcanza). En una
          notebook con menos de ~850px de alto útil el botón Guardar quedaba FUERA
          de la pantalla, sin forma de apretarlo salvo achicando el zoom del
          navegador. Medido con Playwright a 720/800/900/1000px de viewport: ya
          pasaba antes del switch, y el switch lo empeoraba 53px. */}
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar" : "Nuevo"} producto</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Código *</Label>
            <Input value={form.codigo} onChange={(e) => set("codigo", e.target.value)} />
          </div>
          <div>
            <Label>Unidad</Label>
            <Input
              value={form.unidad_medida}
              onChange={(e) => set("unidad_medida", e.target.value)}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label>
              Tamaño de envase{" "}
              <span className="text-xs text-muted-foreground">(litros/kg, ej. 20)</span>
            </Label>
            <NumberInput
              value={form.tamano_envase}
              onValueChange={(v) => set("tamano_envase", v)}
            />
          </div>
          <div className="col-span-2">
            <Label>Nombre *</Label>
            <Input value={form.nombre} onChange={(e) => set("nombre", e.target.value)} />
          </div>
          <div>
            <Label>Categoría</Label>
            <Select
              value={form.categoria_id ?? ""}
              onValueChange={(v) => set("categoria_id", v || null)}
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {categorias.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Marca</Label>
            <Select value={form.marca_id ?? ""} onValueChange={(v) => set("marca_id", v || null)}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {marcas.map((m: any) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Proveedor</Label>
            <Select
              value={form.proveedor_id ?? "__none__"}
              onValueChange={(v) => {
                const id = v === "__none__" ? null : v;
                // Cambiar de proveedor cambia el descuento, y con él el costo.
                const prov = proveedores?.find((x: any) => x.id === id) ?? null;
                // El descuento propio del producto le gana igual al del
                // proveedor nuevo: es una decisión sobre ESTE renglón.
                const desc = descuentoEfectivo(form, prov, {
                  descuento_proveedor_porcentaje: descuentoProveedor,
                });
                recalcVenta({
                  proveedor_id: id,
                  precio_fabrica:
                    Number(form.precio_lista || 0) > 0
                      ? costoDeLista(form.precio_lista, desc)
                      : form.precio_fabrica,
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— (sin proveedor)</SelectItem>
                {(proveedores ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.razon_social}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Precio de lista (Quimex)</Label>
            <NumberInput
              value={form.precio_lista}
              onValueChange={(v) =>
                recalcVenta({
                  precio_lista: v ?? 0,
                  precio_fabrica: costoDeLista(v ?? 0, descuentoDelProducto),
                })
              }
            />
          </div>
          <div>
            <Label>
              % Descuento sobre la lista{" "}
              <span className="text-xs text-muted-foreground">
                (vacío = usa {descuentoHeredado}%)
              </span>
            </Label>
            <NumberInput
              value={form.descuento_porcentaje}
              onValueChange={(v) =>
                recalcVenta({
                  descuento_porcentaje: v,
                  // Cambiar el descuento sólo tiene sentido si hay lista de la
                  // cual descontar. Sin lista, el costo está cargado a mano y no
                  // se toca.
                  precio_fabrica:
                    Number(form.precio_lista || 0) > 0
                      ? costoDeLista(form.precio_lista, v ?? descuentoHeredado)
                      : form.precio_fabrica,
                })
              }
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              El de este producto. Vacío toma el del proveedor, y si no tiene, el general.
            </p>
          </div>
          <div>
            <Label>
              Precio Fábrica (costo){" "}
              <span className="text-xs text-muted-foreground">
                (lista − {descuentoDelProducto}%)
              </span>
            </Label>
            <NumberInput
              value={form.precio_fabrica}
              onValueChange={(v) => recalcVenta({ precio_fabrica: v ?? 0 })}
            />
          </div>
          <div>
            <Label>
              Sugerido al público{" "}
              <span className="text-xs text-muted-foreground">(c/IVA, vacío = no tiene)</span>
            </Label>
            <NumberInput
              value={form.precio_sugerido_publico}
              onValueChange={(v) => recalcVenta({ precio_sugerido_publico: v })}
            />
          </div>
          <div>
            <Label>
              % Markup{" "}
              <span className="text-xs text-muted-foreground">
                (vacío = usa default {markupDefault}%)
              </span>
            </Label>
            <NumberInput
              value={form.markup_porcentaje}
              onValueChange={(v) => recalcVenta({ markup_porcentaje: v })}
            />
          </div>
          <div>
            <Label>Precio s/IVA</Label>
            <NumberInput
              value={form.precio_sin_iva}
              onValueChange={(v) => set("precio_sin_iva", v ?? 0)}
            />
            {esManual && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Este precio no es el que da la fórmula, que daría{" "}
                <strong className="font-mono">{fmtMoney(calculado.precio_sin_iva)}</strong>. Puede
                estar puesto a mano, o calculado con un markup anterior.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => set("precio_sin_iva", calculado.precio_sin_iva)}
                >
                  Usar el calculado
                </button>
              </p>
            )}
          </div>
          <div>
            <Label>IVA %</Label>
            <Select
              value={String(form.iva_porcentaje)}
              onValueChange={(v) => recalcVenta({ iva_porcentaje: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="21">21%</SelectItem>
                <SelectItem value="10.5">10,5%</SelectItem>
                <SelectItem value="0">Exento</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 text-sm bg-muted/30 p-2 rounded space-y-1">
            <div>
              <strong>Precio c/IVA:</strong> <span className="font-mono">{fmtMoney(cIva)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              lista {fmtMoney(form.precio_lista || 0)} → costo {fmtMoney(form.precio_fabrica || 0)}{" "}
              → costo c/IVA {fmtMoney(calculado.costo_c_iva)}
              {form.precio_sugerido_publico
                ? ` → sugerido ${fmtMoney(form.precio_sugerido_publico)}`
                : " → sin sugerido"}{" "}
              → venta {fmtMoney(cIva)}
            </div>
          </div>
          <div>
            <Label>Stock mínimo</Label>
            <NumberInput
              value={form.stock_minimo}
              onValueChange={(v) => set("stock_minimo", v ?? 0)}
            />
          </div>
          {/* El control que faltaba: la tabla mostraba "Inactivo" desde siempre y
              no había ninguna forma de cambiarlo. Ver el spec del 10/08/2026. */}
          <div className="col-span-2 rounded bg-muted/30 p-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Switch
                checked={activoGuardado}
                // Prender exige precio y no estar archivado; apagar nunca.
                disabled={!activoGuardado && motivoNo !== null}
                onCheckedChange={(v) => set("activo", v)}
                data-testid="producto-activo"
              />
              <span>
                <strong>Activo.</strong> Un producto apagado no aparece en ventas ni en
                presupuestos, así que no se puede vender.
              </span>
            </label>
            {!activoGuardado && motivoNo && (
              <p className="mt-1 text-[11px] text-warning" data-testid="motivo-no-activar">
                {motivoNo}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreciosDialog({
  open,
  onClose,
  productosSel,
  totalFiltrado,
  markupDefault,
  descuentoGlobal,
  onApplyAll,
  onDone,
}: any) {
  const [op, setOpRaw] = useState<OperacionPrecio>("MARKUP");
  const [pct, setPctRaw] = useState<number | null>(markupDefault);
  // Una clave por intento. La RPC la usa para que un doble click, un reintento o
  // un F5 no repitan la operación: "aumentar 20%" dos veces da +44% y no se
  // deshace con un botón. Se renueva recién cuando una operación termina bien.
  const [clave, setClave] = useState(() => uuidv4());
  // La clave identifica UNA operación concreta. Si cambia la operación o el %, es
  // otra cosa y necesita su propia clave: si no, la RPC la rechaza por no coincidir.
  const setOp = (v: OperacionPrecio) => {
    setOpRaw(v);
    setClave(uuidv4());
  };
  const setPct = (v: number | null) => {
    setPctRaw(v);
    setClave(uuidv4());
  };

  const ids = productosSel.map((p: any) => p.id);
  const porcentaje = op === "RECALCULAR_COSTO" ? 0 : (pct ?? 0);

  const simulados = productosSel.map((p: any) => ({
    p,
    r: simularOperacion(p, op, porcentaje, { markupDefault, descuentoGlobal }),
  }));
  const conBase = simulados.filter((s: any) => s.r.con_base);
  const cambian = conBase.filter((s: any) => s.r.cambia);
  const aMano = cambian.filter((s: any) => !s.r.derivado).length;
  const sinCambio = conBase.length - cambian.length;
  const sinBase = simulados.length - conBase.length;

  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("cambiar_precios_masivo", {
        p_producto_ids: ids,
        p_operacion: op,
        p_porcentaje: porcentaje,
        p_idempotency_key: clave,
      });
      if (error) throw new Error(error.message);
      return data as any;
    },
    onSuccess: (r: any) => {
      if (r?.ya_aplicado) {
        toast.info("Esta operación ya se había aplicado. No se volvió a hacer.");
      } else {
        const partes = [`${r.actualizados} con precio recalculado`];
        if (r.precio_manual > 0)
          partes.push(
            `${r.precio_manual} tienen el precio puesto a mano y se dejaron como estaban`,
          );
        if (r.sin_base > 0) partes.push(`${r.sin_base} sin precio de lista ni costo cargado`);
        toast.success(partes.join(" · "));
      }
      setClave(uuidv4());
      onDone();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const etiquetaBoton =
    op === "RECALCULAR_COSTO"
      ? `Recalcular el costo de ${ids.length} productos`
      : `${OPERACION_LABEL[op]} ${porcentaje}% a ${ids.length} productos`;

  const OPCIONES: [OperacionPrecio, string, string][] = [
    [
      "MARKUP",
      "Poner este % de ganancia",
      "Al precio sugerido al público le suma este %, y ese es el precio de venta. Si el producto no tiene sugerido, se lo suma al costo.",
    ],
    [
      "AUMENTO",
      "Aumentar los precios este %",
      "Para cuando el proveedor manda lista nueva. Sube el precio de lista y el sugerido, y el costo se recalcula con el descuento del proveedor.",
    ],
    [
      "RECALCULAR_COSTO",
      "Recalcular el costo con el descuento actual",
      "Para después de cambiarle el descuento a un proveedor. No toca el precio de lista.",
    ],
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cambiar precios</DialogTitle>
        </DialogHeader>

        {ids.length === 0 ? (
          <div className="text-sm">
            <p className="mb-2">No hay productos seleccionados.</p>
            <Button size="sm" variant="outline" onClick={onApplyAll}>
              Seleccionar los {totalFiltrado} que se ven
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {OPCIONES.map(([valor, titulo, ayuda]) => (
                <label
                  key={valor}
                  className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer ${
                    op === valor ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <input
                    type="radio"
                    className="mt-1"
                    checked={op === valor}
                    onChange={() => setOp(valor)}
                  />
                  <span>
                    <span className="text-sm font-medium">{titulo}</span>
                    <span className="block text-[11px] text-muted-foreground">{ayuda}</span>
                  </span>
                </label>
              ))}
            </div>

            {op !== "RECALCULAR_COSTO" && (
              <div className="max-w-[10rem]">
                <Label>%</Label>
                <NumberInput value={pct} onValueChange={setPct} />
              </div>
            )}

            {/* No hay historial de precios: esta pantalla es la única oportunidad
                de darse cuenta antes. "Aumentar" no se deshace con un botón. */}
            <div className="rounded-lg bg-muted/30 p-3 text-xs space-y-1">
              <p className="font-medium">Así van a quedar:</p>
              {cambian.slice(0, 3).map(({ p, r }: any) => (
                <div key={p.id} className="font-mono flex flex-wrap gap-x-3">
                  <span className="min-w-[12rem] truncate">{p.nombre}</span>
                  {/* Se muestra la columna que ESTA operación cambia: mostrar la
                      lista en "recalcular el costo" —que no la toca— dejaba a la
                      vista previa sin decir nada sobre lo único que iba a pasar. */}
                  {op !== "MARKUP" && (
                    <span className="text-muted-foreground">
                      costo {fmtMoney(p.precio_fabrica ?? 0)} → {fmtMoney(r.precio_fabrica)}
                    </span>
                  )}
                  {op === "AUMENTO" && (
                    <span className="text-muted-foreground">
                      lista {fmtMoney(p.precio_lista ?? 0)} → {fmtMoney(r.precio_lista)}
                    </span>
                  )}
                  <span>
                    venta{" "}
                    {fmtMoney(Number(p.precio_sin_iva) * (1 + Number(p.iva_porcentaje) / 100))} →{" "}
                    {fmtMoney(r.venta_c_iva)}
                  </span>
                </div>
              ))}
              {cambian.length > 3 && (
                <p className="text-muted-foreground">…y {cambian.length - 3} productos más</p>
              )}
              {cambian.length === 0 && (
                <p className="text-muted-foreground">
                  Ninguno de los seleccionados cambia con esta operación: ya están como corresponde.
                </p>
              )}
              {sinCambio > 0 && cambian.length > 0 && (
                <p className="text-muted-foreground">
                  {sinCambio} ya están como corresponde y no se tocan.
                </p>
              )}
              {aMano > 0 && (
                <p className="text-muted-foreground">
                  {aMano} tienen el precio de venta puesto a mano: se les actualiza el costo, pero
                  el precio de venta queda como está.
                </p>
              )}
              {sinBase > 0 && (
                <p className="text-muted-foreground">
                  {sinBase} no tienen precio de lista ni costo cargado: no se tocan.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>
            Cancelar
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={
              m.isPending || ids.length === 0 || (op !== "RECALCULAR_COSTO" && pct === null)
            }
          >
            {etiquetaBoton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
