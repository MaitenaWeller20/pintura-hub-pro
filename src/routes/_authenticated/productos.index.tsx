import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney } from "@/lib/format";
import { toast } from "sonner";
import { Plus, Upload, Pencil, Printer, Percent, Trash2, ArchiveRestore } from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { useServerFn } from "@tanstack/react-start";
import { aplicarMarkup } from "@/lib/cobranzas.functions";
import { eliminarProductos, restaurarProductos } from "@/lib/productos.functions";
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

// Calcula precio venta s/IVA según fábrica y markup efectivo (individual o default)
const calcPrecio = (fabrica: number, markup: number) => +(fabrica * (1 + markup / 100)).toFixed(2);
// Costo (precio de fábrica) a partir del precio de lista de Quimex y su descuento comercial.
const costoDeLista = (lista: number, descuento: number) =>
  +(lista * (1 - descuento / 100)).toFixed(2);

function Productos() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [openMarkup, setOpenMarkup] = useState(false);
  const [verArchivados, setVerArchivados] = useState(false);
  const [aEliminar, setAEliminar] = useState<any[] | null>(null); // productos a confirmar eliminación
  const eliminarFn = useServerFn(eliminarProductos);
  const restaurarFn = useServerFn(restaurarProductos);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await supabase.from("settings").select("*").maybeSingle()).data,
  });
  const markupDefault = Number(settings?.markup_default_porcentaje ?? 50);
  const descuentoProveedor = Number(settings?.descuento_proveedor_porcentaje ?? 42);

  const { data: productos = [] } = useQuery({
    queryKey: ["productos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("productos")
        .select("*, categoria:categorias(id,nombre), marca:marcas(id,nombre)")
        .order("nombre");
      return (data ?? []) as any[];
    },
  });
  const { data: categorias = [] } = useQuery({
    queryKey: ["categorias"],
    queryFn: async () =>
      ((await supabase.from("categorias").select("*").order("nombre")).data ?? []) as any[],
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
        if (catFilter !== "all" && p.categoria_id !== catFilter) return false;
        if (
          q &&
          !`${p.codigo} ${p.nombre} ${p.marca?.nombre ?? ""}`
            .toLowerCase()
            .includes(q.toLowerCase())
        )
          return false;
        return true;
      }),
    [productos, q, catFilter, verArchivados],
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

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((p: any) => {
        const mk = p.markup_porcentaje ?? markupDefault;
        const sIva = Number(p.precio_sin_iva);
        return {
          Código: p.codigo,
          Nombre: p.nombre,
          Categoría: p.categoria?.nombre,
          Marca: p.marca?.nombre,
          Unidad: p.unidad_medida,
          "Precio Fábrica": Number(p.precio_fabrica ?? 0),
          "% Markup": mk,
          "Precio s/IVA": sIva,
          "IVA %": p.iva_porcentaje,
          "Precio c/IVA": +(sIva * (1 + Number(p.iva_porcentaje) / 100)).toFixed(2),
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
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text("CasaForma — Listado de productos", 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [["Código", "Nombre", "Marca", "P.Fábrica", "%", "P.s/IVA", "IVA", "P.c/IVA"]],
      body: filtered.map((p: any) => {
        const mk = p.markup_porcentaje ?? markupDefault;
        const sIva = Number(p.precio_sin_iva);
        return [
          p.codigo,
          p.nombre,
          p.marca?.nombre ?? "",
          fmtMoney(p.precio_fabrica ?? 0),
          `${mk}%`,
          fmtMoney(sIva),
          `${p.iva_porcentaje}%`,
          fmtMoney(sIva * (1 + Number(p.iva_porcentaje) / 100)),
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
                  <Percent className="h-4 w-4 mr-1" /> Aplicar markup
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
          {cu.isAdmin && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer ml-auto">
              <Checkbox
                checked={verArchivados}
                onCheckedChange={(v) => {
                  setVerArchivados(!!v);
                  setSeleccion(new Set());
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
                <TableHead>Marca</TableHead>
                <TableHead className="text-right">P. Fábrica</TableHead>
                <TableHead className="text-right">% Markup</TableHead>
                <TableHead className="text-right">P. s/IVA</TableHead>
                <TableHead>IVA</TableHead>
                <TableHead className="text-right">P. c/IVA</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p: any) => {
                const mk = p.markup_porcentaje ?? markupDefault;
                const sIva = Number(p.precio_sin_iva);
                const cIva = sIva * (1 + Number(p.iva_porcentaje) / 100);
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
                    <TableCell className="text-muted-foreground">{p.marca?.nombre}</TableCell>
                    <TableCell className="text-right font-mono">
                      {fmtMoney(p.precio_fabrica ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {mk}%{" "}
                      {p.markup_porcentaje == null && (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          def
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(sIva)}</TableCell>
                    <TableCell>{p.iva_porcentaje}%</TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {fmtMoney(cIva)}
                    </TableCell>
                    <TableCell>
                      {cu.isAdmin && (
                        <div className="flex justify-end gap-1">
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
                        </div>
                      )}
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
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["productos"] });
          setOpen(false);
        }}
      />

      <MarkupDialog
        open={openMarkup}
        onClose={() => setOpenMarkup(false)}
        productoIds={Array.from(seleccion)}
        totalFiltrado={filtered.length}
        currentDefault={markupDefault}
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
        unidad_medida: "unidad",
        tamano_envase: null,
        precio_lista: 0,
        precio_fabrica: 0,
        markup_porcentaje: null,
        precio_sin_iva: 0,
        iva_porcentaje: 21,
        stock_minimo: 0,
        activo: true,
      },
  );
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  // Recalcular precio s/IVA al cambiar fábrica o markup
  const recalcPrecio = (fabrica: number, markup: number | null) => {
    const mk = markup ?? markupDefault;
    set("precio_sin_iva", calcPrecio(fabrica || 0, mk));
  };
  // Al cambiar el precio de lista de Quimex: costo = lista − descuento, y luego venta.
  const recalcDesdeLista = (lista: number) => {
    const fabrica = costoDeLista(lista || 0, descuentoProveedor);
    set("precio_fabrica", fabrica);
    recalcPrecio(fabrica, form.markup_porcentaje);
  };

  const m = useMutation({
    mutationFn: async () => {
      const payload = {
        codigo: form.codigo,
        nombre: form.nombre,
        categoria_id: form.categoria_id,
        marca_id: form.marca_id,
        unidad_medida: form.unidad_medida,
        tamano_envase:
          form.tamano_envase === null || form.tamano_envase === ""
            ? null
            : Number(form.tamano_envase),
        precio_lista: Number(form.precio_lista || 0),
        precio_fabrica: Number(form.precio_fabrica || 0),
        markup_porcentaje:
          form.markup_porcentaje === null || form.markup_porcentaje === ""
            ? null
            : Number(form.markup_porcentaje),
        precio_sin_iva: Number(form.precio_sin_iva || 0),
        iva_porcentaje: Number(form.iva_porcentaje),
        stock_minimo: Number(form.stock_minimo || 0),
        activo: form.activo,
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
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
            <Label>Precio de lista (Quimex)</Label>
            <NumberInput
              value={form.precio_lista}
              onValueChange={(v) => {
                set("precio_lista", v ?? 0);
                recalcDesdeLista(v ?? 0);
              }}
            />
          </div>
          <div>
            <Label>
              Precio Fábrica (costo){" "}
              <span className="text-xs text-muted-foreground">(lista − {descuentoProveedor}%)</span>
            </Label>
            <NumberInput
              value={form.precio_fabrica}
              onValueChange={(v) => {
                set("precio_fabrica", v ?? 0);
                recalcPrecio(v ?? 0, form.markup_porcentaje);
              }}
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
              onValueChange={(v) => {
                set("markup_porcentaje", v);
                recalcPrecio(Number(form.precio_fabrica || 0), v);
              }}
            />
          </div>
          <div>
            <Label>Precio s/IVA</Label>
            <NumberInput
              value={form.precio_sin_iva}
              onValueChange={(v) => set("precio_sin_iva", v ?? 0)}
            />
          </div>
          <div>
            <Label>IVA %</Label>
            <Select
              value={String(form.iva_porcentaje)}
              onValueChange={(v) => set("iva_porcentaje", Number(v))}
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
          <div className="col-span-2 text-sm bg-muted/30 p-2 rounded">
            <strong>Precio c/IVA:</strong> <span className="font-mono">{fmtMoney(cIva)}</span>
          </div>
          <div>
            <Label>Stock mínimo</Label>
            <NumberInput
              value={form.stock_minimo}
              onValueChange={(v) => set("stock_minimo", v ?? 0)}
            />
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

function MarkupDialog({
  open,
  onClose,
  productoIds,
  totalFiltrado,
  currentDefault,
  onApplyAll,
  onDone,
}: any) {
  const aplicar = useServerFn(aplicarMarkup);
  const [pct, setPct] = useState<number | null>(currentDefault);
  const [setDefault, setSetDefault] = useState(false);
  const m = useMutation({
    mutationFn: async () =>
      aplicar({
        data: {
          producto_ids: productoIds,
          markup_porcentaje: Number(pct || 0),
          setear_como_default: setDefault,
          sobrescribir_individual: true,
        },
      }),
    onSuccess: (r: any) => {
      const partes = [`${r.actualizados} con precio recalculado`];
      if (r.sin_costo > 0) partes.push(`${r.sin_costo} sin costo cargado (markup guardado)`);
      toast.success(`Markup aplicado: ${partes.join(" · ")}`);
      onDone();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aplicar % de markup</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {productoIds.length === 0 ? (
            <div className="text-sm">
              <p className="mb-2">No hay productos seleccionados.</p>
              <Button size="sm" variant="outline" onClick={onApplyAll}>
                Seleccionar los {totalFiltrado} visibles
              </Button>
            </div>
          ) : (
            <p className="text-sm">
              Se aplicará a <strong>{productoIds.length}</strong> productos. Recalcula precio s/IVA
              = fábrica × (1 + %).
            </p>
          )}
          <div>
            <Label>% Markup</Label>
            <NumberInput value={pct} onValueChange={setPct} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={setDefault} onCheckedChange={(v) => setSetDefault(!!v)} />
            Setear este % como default global (afecta a productos sin markup propio).
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={m.isPending || productoIds.length === 0 || pct === null}
          >
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
