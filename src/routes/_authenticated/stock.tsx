import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useRef, useCallback, memo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableRow, TableCell } from "@/components/ui/table";
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
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { NumberInput } from "@/components/ui/number-input";
import { fmtNum } from "@/lib/format";
import { traerTodo } from "@/lib/supabase-paginado";
import { uuidv4 } from "@/lib/uuid";
import { useServerFn } from "@tanstack/react-start";
import { ajusteStock, conteoFisico } from "@/lib/stock.functions";
import { toast } from "sonner";
import { Pencil, Printer, ClipboardList, Upload, Loader2, AlertTriangle, Download } from "lucide-react";
import * as XLSX from "xlsx";
import {
  TOPE_ITEMS,
  aCsv,
  detectarColumnas,
  procesarConteo,
  type Columnas,
  type ItemVolcado,
} from "@/lib/importar-conteo";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/stock")({
  component: Stock,
});

type FilaInventario = {
  producto_id: string;
  codigo: string;
  nombre: string;
  stock_minimo: number;
  tamano_envase: number | null;
  sucursal_id: string;
  sucursal_nombre: string;
  cantidad: number;
  cargado: boolean;
};

/**
 * El estado de una fila del inventario.
 *
 * "Sin contar" no es lo mismo que "sin stock", y la diferencia no se puede leer
 * de la cantidad: la corrección del envase (20260724150000) dejó 113 filas en 0
 * SIN kardex a propósito, y contar CERO tampoco deja kardex (no hay nada que
 * mover). Por eso la vista trae `cargado`: tiene kardex O fue parte de un conteo.
 */
function estadoDe(f: FilaInventario) {
  if (!f.cargado) return { tono: "neutral" as const, txt: "Sin contar" };
  if (f.cantidad <= 0) return { tono: "danger" as const, txt: "Sin stock" };
  if (f.cantidad <= Number(f.stock_minimo)) return { tono: "warning" as const, txt: "Bajo" };
  return { tono: "success" as const, txt: "OK" };
}

type AjusteState = {
  producto_id: string;
  sucursal_id: string;
  producto_nombre: string;
  sucursal_nombre: string;
  cantidad_actual: number;
};

/**
 * Una fila del inventario. Memoizada: en modo conteo hay ~2266 de estas, cada
 * una con un input controlado; sin el memo, tipear en UNA re-renderiza TODAS.
 * Por eso `valor` es el número de esta fila (no el Map entero) y los callbacks
 * llegan estables desde el padre (useCallback / setState).
 */
const InventarioRow = memo(function InventarioRow({
  fila,
  contando,
  valor,
  esAdmin,
  onContar,
  onAjustar,
}: {
  fila: FilaInventario;
  contando: boolean;
  valor: number | null;
  esAdmin: boolean;
  onContar: (producto_id: string, v: number | null) => void;
  onAjustar: (a: AjusteState) => void;
}) {
  const est = estadoDe(fila);
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{fila.codigo}</TableCell>
      <TableCell>{fila.nombre}</TableCell>
      {/* El envase al lado de la cantidad: son cosas distintas y confundirlas ya
          costó un inventario entero. */}
      <TableCell className="text-right font-mono text-muted-foreground">
        {fila.tamano_envase ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">{fila.sucursal_nombre}</TableCell>
      <TableCell className="text-right font-mono">
        {contando ? (
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">{fmtNum(fila.cantidad)}</span>
            <NumberInput
              className="w-24"
              value={valor}
              onValueChange={(v) => onContar(fila.producto_id, v)}
            />
          </div>
        ) : (
          fmtNum(fila.cantidad)
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-muted-foreground">
        {fmtNum(fila.stock_minimo)}
      </TableCell>
      <TableCell>
        <StatusPill tone={est.tono}>{est.txt}</StatusPill>
      </TableCell>
      <TableCell>
        {esAdmin && !contando && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onAjustar({
                producto_id: fila.producto_id,
                sucursal_id: fila.sucursal_id,
                producto_nombre: fila.nombre,
                sucursal_nombre: fila.sucursal_nombre,
                cantidad_actual: fila.cantidad,
              })
            }
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
});

function Stock() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucFilter, setSucFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [bajoSolo, setBajoSolo] = useState(false);
  const [sinContarSolo, setSinContarSolo] = useState(false);
  const [ajuste, setAjuste] = useState<AjusteState | null>(null);
  const ajusteFn = useServerFn(ajusteStock);
  const conteoFn = useServerFn(conteoFisico);

  // --- modo conteo ---
  const [contando, setContando] = useState(false);
  const [motivoConteo, setMotivoConteo] = useState("Conteo físico");
  // Lo tipeado vive acá, fuera de las filas: filtrar o buscar no lo pierde.
  // null = el input está vacío (no se manda). 0 es un VALOR: "lo conté y no hay".
  const [contado, setContado] = useState<Map<string, number | null>>(new Map());
  // Momento en que se abrió el conteo. Lo que se mueva después de esta hora se
  // suma a lo contado en vez de pisarse (§5.4 del spec).
  const contadoDesde = useRef<string | null>(null);
  // Clave de idempotencia POR INTENTO de guardado, generada UNA vez y estable
  // ante reintentos: un doble click o un retry de react-query mandan la misma
  // clave, así el backend colapsa los dos en un solo conteo. Se rota recién
  // cuando un guardado termina OK (para el próximo lote de la misma sesión).
  const idemKey = useRef<string>(uuidv4());
  const [cancelarAbierto, setCancelarAbierto] = useState(false);
  const [importarAbierto, setImportarAbierto] = useState(false);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const sucId = sucFilter || (cu?.isAdmin ? "" : (cu?.sucursal?.id ?? ""));

  const { data: inventario, isLoading } = useQuery({
    queryKey: ["inventario", sucId],
    enabled: !!cu,
    queryFn: async () => {
      // Paginado explícito: PostgREST corta en 1000 filas y no avisa. Acá son
      // ~1200 productos × sucursales, así que sin esto la planilla del conteo
      // saldría incompleta sin que nadie se entere. El orden tiene que ser
      // total y estable o la paginación por offset saltea/repite.
      return traerTodo<FilaInventario>(async (desde, hasta) => {
        let sel = supabase
          .from("stock_inventario")
          .select(
            "producto_id,codigo,nombre,stock_minimo,tamano_envase,sucursal_id,sucursal_nombre,cantidad,cargado",
            { count: "exact" },
          )
          .order("codigo")
          .order("sucursal_id")
          .range(desde, hasta);
        if (sucId) sel = sel.eq("sucursal_id", sucId);
        const { data, error, count } = await sel;
        return { data: data as unknown as FilaInventario[] | null, error, count };
      });
    },
  });
  // Estabilizado a propósito: `inventario?.filas ?? []` crea un array nuevo en
  // cada render y haría recalcular el filtro de 2266 filas todo el tiempo,
  // justo mientras se tipea el conteo.
  const filas = useMemo(() => inventario?.filas ?? [], [inventario]);
  const truncado = inventario?.truncado ?? false;

  const filtered = useMemo(
    () =>
      filas.filter((s) => {
        if (sinContarSolo && s.cargado) return false;
        // Lo que nadie contó no es "stock bajo": es desconocido.
        if (bajoSolo && !(s.cargado && s.cantidad <= Number(s.stock_minimo))) return false;
        if (q && !`${s.codigo} ${s.nombre}`.toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      }),
    [filas, q, bajoSolo, sinContarSolo],
  );

  const m = useMutation({
    mutationFn: async (data: any) => ajusteFn({ data }),
    onSuccess: () => {
      toast.success("Stock ajustado");
      qc.invalidateQueries({ queryKey: ["inventario"] });
      setAjuste(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Callback estable: sin esto, cada fila recibiría una función nueva por render
  // y el memo de InventarioRow no serviría de nada (tipear re-renderiza las 2266).
  const setContadoDe = useCallback((producto_id: string, v: number | null) => {
    setContado((prev) => {
      const next = new Map(prev);
      next.set(producto_id, v);
      return next;
    });
  }, []);

  // Sólo las filas con algo tipeado. Ojo: "0" ES un valor —"lo conté y no
  // hay"— así que el criterio es "el input no está vacío", nunca un if truthy.
  const itemsConteo = useMemo(() => {
    const out: Array<{ producto_id: string; cantidad: number }> = [];
    for (const [producto_id, cantidad] of contado) {
      // `cantidad === 0` tiene que pasar. Un `if (cantidad)` acá se comería
      // justamente el dato más importante del conteo.
      if (cantidad === null || !Number.isFinite(cantidad) || cantidad < 0) continue;
      out.push({ producto_id, cantidad });
    }
    return out;
  }, [contado]);

  const guardarConteo = useMutation({
    mutationFn: async () =>
      conteoFn({
        data: {
          sucursal_id: sucId,
          motivo: motivoConteo.trim() || "Conteo físico",
          contado_desde: contadoDesde.current,
          idempotency_key: idemKey.current,
          items: itemsConteo,
        },
      }),
    onSuccess: (r: any) => {
      const partes = [`${r.ajustados} ajustado${r.ajustados === 1 ? "" : "s"}`];
      if (r.sin_cambio) partes.push(`${r.sin_cambio} sin cambio`);
      if (r.con_movimientos)
        partes.push(
          `${r.con_movimientos} con movimientos posteriores al conteo (se sumaron, no se pisaron)`,
        );
      if (r.conflictos)
        toast.warning(
          `${r.conflictos} producto${r.conflictos === 1 ? "" : "s"} quedaron en 0: se vendió más de lo contado. Revisalos.`,
        );
      toast.success(partes.join(" · "));
      setContado(new Map());
      setContando(false);
      contadoDesde.current = null;
      idemKey.current = uuidv4(); // el próximo conteo es otro documento
      // El conteo mueve stock: refrescar también el catálogo y el dashboard.
      qc.invalidateQueries({ queryKey: ["inventario"] });
      qc.invalidateQueries({ queryKey: ["productos"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  /**
   * `conImportacion` existe porque importar un archivo ES un conteo: el archivo
   * dice cuánto hay de cada cosa. Pero desde /stock eso no se veía por ningún
   * lado —el botón vivía adentro del modo conteo— y el reporte que llegó fue
   * "no me deja importar el archivo". Ahora hay una puerta directa.
   */
  const abrirConteo = async (conImportacion = false) => {
    if (!sucId) {
      toast.error(
        `Elegí primero una sucursal en el filtro de abajo: ${conImportacion ? "importar" : "contar"} «todas» a la vez no significa nada.`,
        { duration: 6000 },
      );
      return;
    }
    // La hora la pone el SERVIDOR, no el reloj del navegador: de eso depende que
    // los movimientos hechos durante el conteo se sumen bien y no al revés.
    const { data, error } = await supabase.rpc("iniciar_conteo_stock");
    // Si falla, contado_desde queda null (ajuste absoluto) — nunca la hora local.
    contadoDesde.current = error ? null : (data as unknown as string);
    setContado(new Map());
    setContando(true);
    if (conImportacion) setImportarAbierto(true);
  };

  // Un solo setState para las ~1600 filas. Llamar al setter una vez por fila
  // dispararía 1600 renders de una tabla de 2266 inputs controlados.
  const volcarImportacion = useCallback((items: ItemVolcado[]) => {
    setContado((prev) => {
      const next = new Map(prev);
      for (const it of items) next.set(it.producto_id, it.cantidad);
      return next;
    });
    setImportarAbierto(false);
    toast.success(
      `${items.length} producto${items.length === 1 ? "" : "s"} cargados en el conteo. ` +
        `Revisalos y después apretá "Guardar conteo".`,
    );
  }, []);

  const cerrarConteo = () => {
    setContado(new Map());
    setContando(false);
    contadoDesde.current = null;
    setCancelarAbierto(false);
  };

  const sucNombre = sucId ? (sucs.find((s: any) => s.id === sucId)?.nombre ?? "") : "Global";

  const imprimir = () => {
    const doc = new jsPDF();
    doc.setFontSize(14);
    // El PDF es la planilla con la que se cuenta. Si sale una vista filtrada y
    // no lo dice, se cuenta de menos y nadie se entera.
    const filtrada = filtered.length !== filas.length;
    doc.text(`CasaForma — Stock ${sucNombre}`, 14, 16);
    doc.setFontSize(9);
    doc.text(
      `${filtered.length} de ${filas.length} ítems${filtrada ? " — VISTA FILTRADA" : ""}`,
      14,
      21,
    );
    autoTable(doc, {
      startY: 26,
      head: [["Código", "Producto", "Env.", "Sucursal", "Cantidad", "Mín.", "Estado", "Contado"]],
      body: filtered.map((s) => [
        s.codigo,
        s.nombre,
        s.tamano_envase ?? "—",
        s.sucursal_nombre ?? "",
        fmtNum(s.cantidad),
        s.stock_minimo,
        estadoDe(s).txt,
        "", // para escribir a mano
      ]),
      styles: { fontSize: 8 },
    });
    doc.save("stock.pdf");
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventario"
        subtitle={`${filtered.length} de ${filas.length} ítems`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={imprimir}>
              <Printer className="h-4 w-4 mr-1" /> Imprimir PDF
            </Button>
            {cu?.isAdmin && !contando && (
              <>
                <Button
                  variant="outline"
                  onClick={() => abrirConteo(true)}
                  title={sucId ? "Cargar las cantidades desde un Excel o CSV" : "Elegí primero una sucursal"}
                >
                  <Upload className="h-4 w-4 mr-1" /> Importar conteo
                </Button>
                <Button onClick={() => abrirConteo(false)}>
                  <ClipboardList className="h-4 w-4 mr-1" /> Conteo físico
                </Button>
              </>
            )}
          </div>
        }
      />

      {truncado && (
        <SectionCard>
          <p className="text-sm text-destructive">
            La lista está <strong>incompleta</strong>: se alcanzó el tope de filas. Filtrá por
            sucursal o avisá, porque un conteo sobre una lista incompleta deja productos sin cargar.
          </p>
        </SectionCard>
      )}

      <SectionCard>
        <div className="flex flex-wrap gap-2 items-center">
          <Input
            placeholder="Buscar producto…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          {cu?.isAdmin && (
            <Select
              value={sucFilter || "__all__"}
              onValueChange={(v) => setSucFilter(v === "__all__" ? "" : v)}
              disabled={contando}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las sucursales</SelectItem>
                {sucs.map((s: any) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <label className="flex items-center gap-2 text-sm ml-2">
            <input
              type="checkbox"
              checked={bajoSolo}
              onChange={(e) => setBajoSolo(e.target.checked)}
            />{" "}
            Solo stock bajo
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sinContarSolo}
              onChange={(e) => setSinContarSolo(e.target.checked)}
            />{" "}
            Solo sin contar
          </label>
        </div>
      </SectionCard>

      <DataTable
        columns={[
          "Código",
          "Producto",
          "Env.",
          "Sucursal",
          contando ? "Contado" : "Cantidad",
          "Mínimo",
          "Estado",
          "",
        ]}
        loading={isLoading}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay ítems de stock para mostrar." }}
      >
        {filtered.map((s) => (
          <InventarioRow
            key={`${s.producto_id}-${s.sucursal_id}`}
            fila={s}
            contando={contando}
            valor={contado.get(s.producto_id) ?? null}
            esAdmin={!!cu?.isAdmin}
            onContar={setContadoDe}
            onAjustar={setAjuste}
          />
        ))}
      </DataTable>

      {contando && (
        <div className="sticky bottom-0 z-10 rounded-2xl border border-border bg-background/95 p-3 shadow-card backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              <strong>{itemsConteo.length}</strong>{" "}
              {itemsConteo.length === 1 ? "producto cargado" : "productos cargados"} en {sucNombre}
            </span>
            <Input
              className="max-w-xs"
              value={motivoConteo}
              onChange={(e) => setMotivoConteo(e.target.value)}
              placeholder="Motivo"
            />
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setImportarAbierto(true)}>
                <Upload className="mr-1 h-4 w-4" /> Importar desde archivo
              </Button>
              <Button
                variant="outline"
                onClick={() => (itemsConteo.length ? setCancelarAbierto(true) : cerrarConteo())}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => guardarConteo.mutate()}
                disabled={itemsConteo.length === 0 || guardarConteo.isPending}
              >
                {guardarConteo.isPending ? "Guardando…" : "Guardar conteo"}
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Se guarda sólo lo que tenga un número escrito. Un <strong>0</strong> también se guarda:
            es "lo conté y no hay". Lo que se venda mientras contás se suma después, no se pisa.
          </p>
        </div>
      )}

      {importarAbierto && (
        <ImportarConteoDialog
          sucursalId={sucId}
          sucursalNombre={sucNombre}
          catalogo={filas}
          yaCargados={contado}
          onClose={() => setImportarAbierto(false)}
          onVolcar={volcarImportacion}
        />
      )}

      <Dialog open={cancelarAbierto} onOpenChange={setCancelarAbierto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Descartar el conteo</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            Tenés {itemsConteo.length} producto{itemsConteo.length === 1 ? "" : "s"} cargado
            {itemsConteo.length === 1 ? "" : "s"} sin guardar. Si salís se pierden.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelarAbierto(false)}>
              Seguir contando
            </Button>
            <Button variant="destructive" onClick={cerrarConteo}>
              Descartar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!ajuste} onOpenChange={(v) => !v && setAjuste(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajuste de stock</DialogTitle>
          </DialogHeader>
          {ajuste && (
            <div className="space-y-3">
              <div className="text-sm">
                <div>
                  <strong>Producto:</strong> {ajuste.producto_nombre}
                </div>
                <div>
                  <strong>Sucursal:</strong> {ajuste.sucursal_nombre}
                </div>
                <div>
                  <strong>Cantidad actual:</strong> {ajuste.cantidad_actual}
                </div>
              </div>
              <div>
                <Label>Nueva cantidad</Label>
                <Input
                  type="number"
                  step="0.01"
                  defaultValue={ajuste.cantidad_actual}
                  id="nueva_cant"
                />
              </div>
              <div>
                <Label>Motivo *</Label>
                <Textarea id="motivo" placeholder="Conteo físico, rotura, devolución, etc." />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAjuste(null)}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    const cant = Number(
                      (document.getElementById("nueva_cant") as HTMLInputElement).value,
                    );
                    const mot = (document.getElementById("motivo") as HTMLTextAreaElement).value;
                    if (!mot.trim()) {
                      toast.error("Motivo requerido");
                      return;
                    }
                    m.mutate({
                      producto_id: ajuste.producto_id,
                      sucursal_id: ajuste.sucursal_id,
                      nueva_cantidad: cant,
                      motivo: mot,
                    });
                  }}
                >
                  Guardar
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Llenar el conteo desde un archivo.
 *
 * NO guarda nada: vuelca los números en los inputs del conteo, que es donde la
 * persona los revisa y desde donde después sale el "Guardar conteo" de siempre.
 * El archivo no es un acto de fe — se ve producto por producto qué va a quedar
 * antes de escribir en la base.
 * Ver docs/superpowers/specs/2026-08-03-importar-conteo-design.md
 */
function ImportarConteoDialog({
  sucursalId,
  sucursalNombre,
  catalogo,
  yaCargados,
  onClose,
  onVolcar,
}: {
  sucursalId: string;
  sucursalNombre: string;
  catalogo: FilaInventario[];
  /** Lo que ya está tipeado en el conteo. Importar lo reemplaza. */
  yaCargados: Map<string, number | null>;
  onClose: () => void;
  onVolcar: (items: ItemVolcado[]) => void;
}) {
  const [nombreArchivo, setNombreArchivo] = useState("");
  const [encabezados, setEncabezados] = useState<string[]>([]);
  const [filasArchivo, setFilasArchivo] = useState<Array<Record<string, unknown>>>([]);
  const [cols, setCols] = useState<Columnas>({
    codigo: null,
    cantidad: null,
    deposito: null,
    fecha: null,
  });
  const [negativosComoCero, setNegativosComoCero] = useState(false);
  const [archivoCompleto, setArchivoCompleto] = useState(false);
  const [confirmaSucursal, setConfirmaSucursal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);

  const catalogoLigero = useMemo(
    () => catalogo.map((f) => ({ producto_id: f.producto_id, codigo: f.codigo })),
    [catalogo],
  );

  const res = useMemo(
    () =>
      filasArchivo.length
        ? procesarConteo(filasArchivo, cols, catalogoLigero, {
            negativosComoCero,
            archivoCompleto,
          })
        : null,
    [filasArchivo, cols, catalogoLigero, negativosComoCero, archivoCompleto],
  );

  // ¿Hubo movimientos en el sistema DESPUÉS de la foto que trae el archivo?
  //
  // Importa porque el conteo PISA: lo que se cargue reemplaza la cantidad. La
  // RPC sabe respetar lo que se mueva después de abrir el conteo, pero no sabe
  // nada de lo que pasó entre que se sacó la foto y ahora — eso se perdería sin
  // que nadie se entere. Así que se cuenta y se muestra.
  const { data: movsPosteriores, isFetching: contandoMovs, isError: fallaMovs } = useQuery({
    queryKey: ["movs-post-snapshot", sucursalId, res?.fechaSnapshot],
    enabled: !!sucursalId && !!res?.fechaSnapshot,
    queryFn: async () => {
      const { count, error: e } = await supabase
        .from("stock_movimientos")
        .select("id", { count: "exact", head: true })
        .eq("sucursal_id", sucursalId)
        .gt("created_at", res!.fechaSnapshot!);
      if (e) throw e;
      return count ?? 0;
    },
  });

  const leerArchivo = async (file: File) => {
    setLeyendo(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      if (wb.SheetNames.length === 0) throw new Error("El archivo no tiene ninguna hoja.");
      // Sólo la primera hoja: adivinar cuál de varias es "la buena" sería inventar.
      const hoja = wb.Sheets[wb.SheetNames[0]];
      const filas = XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja, { defval: "" });
      if (filas.length === 0) throw new Error("La primera hoja está vacía.");
      const heads = Object.keys(filas[0]);
      setEncabezados(heads);
      setFilasArchivo(filas);
      setCols(detectarColumnas(heads));
      setNombreArchivo(file.name);
      // Todo lo que decide sobre datos vuelve a cero con cada archivo. Dejar
      // "inventario completo" prendido de una importación anterior y subir
      // después un archivo parcial pondría en 0 todo lo que no figure.
      setConfirmaSucursal(false);
      setNegativosComoCero(false);
      setArchivoCompleto(false);
    } catch (e: any) {
      setError(e.message ?? "No se pudo leer el archivo.");
      setFilasArchivo([]);
      setEncabezados([]);
    } finally {
      setLeyendo(false);
    }
  };

  // Cuántos de los que trae el archivo YA tienen un número puesto a mano (o de
  // una importación anterior). Importar los reemplaza, y perder una corrección
  // hecha a mano sin que nadie avise es la clase de cosa que se descubre tarde.
  const pisados = res
    ? res.aVolcar.filter((i) => yaCargados.get(i.producto_id) != null).length
    : 0;

  const bajarCsv = (nombre: string, filas: Array<Record<string, string | number>>) => {
    const url = URL.createObjectURL(new Blob([aCsv(filas)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Todo lo que impide volcar, en un solo lugar y en orden.
  const bloqueo = (): string | null => {
    if (!res) return "Elegí un archivo.";
    if (!cols.codigo || !cols.cantidad) return "Elegí qué columna es el código y cuál la cantidad.";
    if (res.depositosMezclados)
      return "El archivo mezcla varios depósitos. Subí uno por sucursal.";
    if (res.excedeTope)
      return `Son ${res.aVolcar.length} productos y el máximo por conteo es ${TOPE_ITEMS}. Partilo en dos.`;
    if (res.aVolcar.length === 0) return "No hay ningún producto para cargar.";
    if (!confirmaSucursal) return "Confirmá que el archivo es de esta sucursal.";
    return null;
  };
  const noPuede = bloqueo();

  const Linea = ({
    n,
    children,
    tono = "",
    accion,
  }: {
    n: number;
    children: React.ReactNode;
    tono?: string;
    accion?: () => void;
  }) => (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-14 text-right font-mono font-semibold ${tono}`}>{n}</span>
      <span className={tono}>{children}</span>
      {accion && n > 0 && (
        <Button size="sm" variant="ghost" className="h-6 px-2" onClick={accion}>
          <Download className="mr-1 h-3 w-3" /> bajar
        </Button>
      )}
    </div>
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar el conteo desde un archivo</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Archivo (.csv, .xlsx, .xls)</Label>
            <Input
              type="file"
              accept=".csv,.xlsx,.xls"
              data-testid="conteo-archivo"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) leerArchivo(f);
              }}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Si tenés el PDF del sistema viejo, convertilo antes con{" "}
              <code className="rounded bg-muted px-1">scripts/existencias-pdf-a-csv.py</code>: ese
              script verifica que no falten páginas y que las cantidades cuadren con el total del
              reporte.
            </p>
          </div>

          {leyendo && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Leyendo…
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {encabezados.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {(["codigo", "cantidad"] as const).map((campo) => (
                <div key={campo}>
                  <Label className="text-xs">
                    {campo === "codigo" ? "Columna del código *" : "Columna de la cantidad *"}
                  </Label>
                  <Select
                    value={cols[campo] ?? "__none__"}
                    onValueChange={(v) =>
                      setCols((c) => ({ ...c, [campo]: v === "__none__" ? null : v }))
                    }
                  >
                    <SelectTrigger className="h-9" data-testid={`conteo-col-${campo}`}>
                      <SelectValue placeholder="Elegí…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— sin elegir —</SelectItem>
                      {encabezados.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {res && (
            <>
              {/* La sucursal es lo único que puede arruinar datos de verdad: subir
                  el archivo de una sucursal contando la otra escribe 1600
                  cantidades reales en el lugar equivocado. Y los nombres de
                  depósito del sistema viejo no son confiables (el de General Paz
                  se llama "Casa Forma"), así que NO se adivina: se muestran los
                  dos y se pide confirmación siempre. */}
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">El archivo dice</div>
                    <div className="font-semibold" data-testid="conteo-deposito">
                      {res.deposito ?? "— no lo aclara —"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Estás contando</div>
                    <div className="font-semibold">{sucursalNombre}</div>
                  </div>
                </div>
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmaSucursal}
                    data-testid="conteo-confirma-sucursal"
                    onChange={(e) => setConfirmaSucursal(e.target.checked)}
                  />
                  <span>
                    Confirmo que este archivo es el stock de <strong>{sucursalNombre}</strong>.
                  </span>
                </label>
              </div>

              {res.fechaSnapshot && (
                <div className="rounded-lg border border-border p-3 text-sm">
                  <div>
                    El archivo es una <strong>foto del {res.fechaSnapshot.replace("T", " ")}</strong>
                    .
                  </div>
                  {contandoMovs ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Buscando movimientos posteriores…
                    </p>
                  ) : fallaMovs || typeof movsPosteriores !== "number" ? (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        No se pudo verificar si hubo movimientos después de esa fecha. Revisá que la
                        fecha del archivo sea válida.
                      </span>
                    </p>
                  ) : movsPosteriores === 0 ? (
                    <p className="mt-1 text-xs text-success">
                      No hubo ningún movimiento de stock en esta sucursal desde entonces.
                    </p>
                  ) : (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Hubo <strong>{movsPosteriores}</strong> movimientos de stock en esta
                        sucursal después de esa hora. Lo que cargues los va a pisar.
                      </span>
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-1 rounded-lg border border-border p-3">
                <Linea n={res.filasLeidas}>filas leídas</Linea>
                <Linea n={res.aVolcar.length} tono="text-success">
                  se van a cargar en el conteo
                </Linea>
                <Linea
                  n={res.noEncontrados.length}
                  tono={res.noEncontrados.length ? "text-warning" : ""}
                  accion={() =>
                    bajarCsv("no-encontrados.csv", res.noEncontrados as any)
                  }
                >
                  no están en el catálogo — se saltean
                </Linea>
                <Linea
                  n={res.repetidos.length}
                  tono={res.repetidos.length ? "text-warning" : ""}
                  accion={() => bajarCsv("repetidos.csv", res.repetidos.map((c) => ({ codigo: c })))}
                >
                  códigos repetidos en el archivo — se saltean
                </Linea>
                <Linea
                  n={res.ilegibles.length}
                  tono={res.ilegibles.length ? "text-warning" : ""}
                  accion={() => bajarCsv("ilegibles.csv", res.ilegibles as any)}
                >
                  cantidades ilegibles
                </Linea>
                {res.sinCodigo > 0 && <Linea n={res.sinCodigo}>filas sin código (ignoradas)</Linea>}
                <Linea n={res.faltantesDelCatalogo}>
                  productos del catálogo que no vinieron en el archivo
                </Linea>
                {pisados > 0 && (
                  <Linea n={pisados} tono="text-warning">
                    ya tenían un número cargado — se van a <strong>reemplazar</strong>
                  </Linea>
                )}
              </div>

              {res.negativos.length > 0 && (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={negativosComoCero}
                    data-testid="conteo-negativos"
                    onChange={(e) => setNegativosComoCero(e.target.checked)}
                  />
                  <span>
                    <strong>{res.negativos.length} productos vienen en negativo</strong> — cargarlos
                    como 0.
                    <span className="block text-xs text-muted-foreground">
                      El sistema viejo permite stock negativo; significa que se vendió más de lo que
                      tenía registrado. Físicamente no se puede tener −1, así que 0 es lo más
                      cercano a la verdad — pero es una corrección nuestra, no un dato del archivo.
                      Si lo dejás sin tildar, esos productos no se tocan.
                    </span>
                  </span>
                </label>
              )}

              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={archivoCompleto}
                  data-testid="conteo-completo"
                  onChange={(e) => setArchivoCompleto(e.target.checked)}
                />
                <span>
                  <strong>Este archivo es el inventario completo de la sucursal</strong>
                  <span className="block text-xs text-muted-foreground">
                    Si lo tildás, los {res.faltantesDelCatalogo} productos del catálogo que no
                    figuran en el archivo se cuentan como <strong>0</strong>. Sin tildar no se
                    tocan, que es lo seguro: un archivo parcial no dice nada sobre lo que no lista.
                  </span>
                </span>
              </label>
            </>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {noPuede && <span className="text-xs text-muted-foreground sm:mr-auto">{noPuede}</span>}
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!!noPuede}
            data-testid="conteo-volcar"
            onClick={() => res && onVolcar(res.aVolcar)}
          >
            Cargar {res?.aVolcar.length ?? 0} en el conteo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
