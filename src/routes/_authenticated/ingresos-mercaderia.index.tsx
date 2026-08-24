import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import {
  DialogoCorregirIngreso,
  type ItemIngresoCorregible,
} from "@/components/ingresos/dialogo-corregir-ingreso";
import {
  HistorialCorreccionesIngreso,
  type CorreccionIngresoVisible,
} from "@/components/ingresos/historial-correcciones-ingreso";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { fmtDate } from "@/lib/format";
import { puedeAbrirCorreccionIngreso } from "@/lib/correccion-ingreso";
import { Plus, Ban, Pencil, Eye } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/ingresos-mercaderia/")({
  component: IngresosPage,
});

type CorreccionIngresoRow = {
  id: string;
  usuario_nombre: string;
  motivo: string;
  created_at: string;
  cambios: Array<{
    ingreso_item_id: string;
    descripcion: string;
    cantidad_anterior: number;
    cantidad_nueva: number;
    diferencia: number;
  }>;
};

// La tabla se crea junto con esta pantalla. El cast evita mezclar en este
// cambio la regeneración completa del archivo automático de tipos de Supabase.
const supabaseCorrecciones = supabase as unknown as SupabaseClient;

/**
 * Qué se cargó en un ingreso.
 *
 * May: "me figura confirmado pero no puedo verlo... estaría bueno que tenga una
 * solapita que pueda ver lo que ingresé para ver si lo ingresé bien, como para
 * un control". Antes un ingreso confirmado sólo ofrecía anularlo.
 *
 * Un ingreso confirmado ya movió stock. La corrección no edita por atrás: abre
 * una operación administrativa separada que ajusta sólo la diferencia y deja
 * quién, cuándo, por qué y el antes/después de cada línea.
 */
function DetalleIngreso({
  ingreso,
  isAdmin,
  onClose,
  onCorregir,
}: {
  ingreso: any;
  isAdmin: boolean;
  onClose: () => void;
  onCorregir: (items: ItemIngresoCorregible[]) => void;
}) {
  const itemsQuery = useQuery({
    queryKey: ["ingreso-items", ingreso.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ingreso_mercaderia_items")
        .select(
          "id, linea, producto_id, origen_match, codigo, descripcion, cantidad, codigo_proveedor, descripcion_proveedor",
        )
        .eq("ingreso_id", ingreso.id)
        .order("linea");
      if (error) throw error;
      return data;
    },
  });
  const items = itemsQuery.data ?? [];

  const correccionesQuery = useQuery({
    queryKey: ["ingreso-correcciones", ingreso.id],
    queryFn: async () => {
      const { data, error } = await supabaseCorrecciones
        .from("ingreso_mercaderia_correcciones")
        .select(
          "id, usuario_nombre, motivo, created_at, cambios:ingreso_mercaderia_correccion_items(ingreso_item_id, descripcion, cantidad_anterior, cantidad_nueva, diferencia)",
        )
        .eq("ingreso_id", ingreso.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CorreccionIngresoRow[];
    },
  });

  const correcciones: CorreccionIngresoVisible[] = (correccionesQuery.data ?? []).map(
    (correccion) => ({
      id: correccion.id,
      corregidoPor: correccion.usuario_nombre,
      corregidoEn: correccion.created_at,
      motivo: correccion.motivo,
      cambios: correccion.cambios.map((cambio) => ({
        itemId: cambio.ingreso_item_id,
        descripcion: cambio.descripcion,
        cantidadAnterior: Number(cambio.cantidad_anterior),
        cantidadNueva: Number(cambio.cantidad_nueva),
        delta: Number(cambio.diferencia),
      })),
    }),
  );

  const itemsCorregibles = items.filter(
    (item) =>
      item.producto_id !== null && item.origen_match !== "IGNORADA" && item.cantidad !== null,
  );

  const total = items.reduce((a, i) => a + Number(i.cantidad || 0), 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Ingreso de {ingreso.proveedor?.razon_social ?? "—"}
            {ingreso.numero_remito_proveedor ? ` — remito ${ingreso.numero_remito_proveedor}` : ""}
          </DialogTitle>
          <DialogDescription>
            Productos y cantidades que impactaron en el stock de esta sucursal.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
          <div>
            <p className="text-xs text-muted-foreground">Estado</p>
            <StatusPill tone={ESTADO_TONE[ingreso.estado as keyof typeof ESTADO_TONE] ?? "neutral"}>
              {ESTADO_LABEL[ingreso.estado as keyof typeof ESTADO_LABEL] ?? ingreso.estado}
            </StatusPill>
            {correcciones.length > 0 && <StatusPill tone="warning">Corregido</StatusPill>}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cargado</p>
            <p>{fmtDate(ingreso.fecha_carga)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Sucursal</p>
            <p>{ingreso.sucursal?.nombre ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Fecha del remito</p>
            <p>{ingreso.fecha_remito ? fmtDate(ingreso.fecha_remito) : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Confirmado</p>
            <p>{ingreso.fecha_confirmacion ? fmtDate(ingreso.fecha_confirmacion) : "—"}</p>
          </div>
        </div>

        {ingreso.observaciones && (
          <p className="rounded border border-border bg-muted/30 p-2 text-sm">
            {ingreso.observaciones}
          </p>
        )}

        <div className="max-h-[45vh] overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {itemsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Cargando…
                  </TableCell>
                </TableRow>
              ) : itemsQuery.isError ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-destructive">
                    No se pudieron cargar los productos del ingreso.
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Este ingreso no tiene productos cargados.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell className="text-xs text-muted-foreground">{i.linea}</TableCell>
                    <TableCell className="font-mono text-xs">{i.codigo ?? "—"}</TableCell>
                    <TableCell>
                      {i.descripcion ?? "—"}
                      {/* Lo que decía el remito del proveedor, si no coincide con
                          el nombre del catálogo. Sirve para cotejar contra el papel. */}
                      {i.descripcion_proveedor && i.descripcion_proveedor !== i.descripcion && (
                        <span className="block text-[10px] text-muted-foreground">
                          en el remito: {i.descripcion_proveedor}
                          {i.codigo_proveedor ? ` (${i.codigo_proveedor})` : ""}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {Number(i.cantidad)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {correccionesQuery.isError && (
          <p className="text-sm text-destructive">
            No se pudo cargar el historial de correcciones.
          </p>
        )}
        <HistorialCorreccionesIngreso correcciones={correcciones} />

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {items.length} {items.length === 1 ? "producto" : "productos"} · {total} unidades
          </span>
          {ingreso.estado === "CONFIRMADO" && (
            <span className="text-xs text-muted-foreground">
              Ya sumó al stock. Una corrección aplica sólo la diferencia y conserva el historial.
            </span>
          )}
        </div>

        <DialogFooter>
          {puedeAbrirCorreccionIngreso({ isAdmin, estado: ingreso.estado }) && (
            <Button
              onClick={() => onCorregir(itemsCorregibles)}
              disabled={itemsQuery.isLoading || itemsQuery.isError || itemsCorregibles.length === 0}
            >
              <Pencil className="mr-1 h-4 w-4" /> Corregir cantidades
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ESTADO_TONE = { BORRADOR: "info", CONFIRMADO: "success", ANULADO: "danger" } as const;
const ESTADO_LABEL = {
  BORRADOR: "Borrador",
  CONFIRMADO: "Confirmado",
  ANULADO: "Anulado",
} as const;

function IngresosPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [anular, setAnular] = useState<any>(null);
  const [ver, setVer] = useState<any>(null);
  const [corregir, setCorregir] = useState<{
    ingreso: any;
    items: ItemIngresoCorregible[];
  } | null>(null);

  const { data: ingresos = [], isLoading } = useQuery({
    queryKey: ["ingresos-mercaderia"],
    queryFn: async () =>
      ((
        await supabase
          .from("ingresos_mercaderia")
          .select("*, proveedor:proveedores(razon_social), sucursal:sucursales(nombre)")
          .order("fecha_carga", { ascending: false })
          .limit(200)
      ).data ?? []) as any[],
  });

  // Borradores primero, después el resto por fecha.
  const ordenados = [...ingresos].sort((a, b) => {
    if (a.estado === "BORRADOR" && b.estado !== "BORRADOR") return -1;
    if (b.estado === "BORRADOR" && a.estado !== "BORRADOR") return 1;
    return 0;
  });

  const anularM = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("anular_ingreso_mercaderia", { p_ingreso_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ingreso anulado");
      qc.invalidateQueries({ queryKey: ["ingresos-mercaderia"] });
      setAnular(null);
    },
    onError: (e: any) => {
      toast.error(e.message);
      setAnular(null);
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ingresos de mercadería"
        subtitle={`${ingresos.length} ingresos`}
        actions={
          <Button asChild>
            <Link to="/ingresos-mercaderia/nuevo" search={{ id: undefined }}>
              <Plus className="h-4 w-4 mr-1" /> Nuevo ingreso
            </Link>
          </Button>
        }
      />

      <DataTable
        columns={["Fecha", "Proveedor", "Sucursal", "Remito", "Estado", ""]}
        loading={isLoading}
        isEmpty={ingresos.length === 0}
        empty={{
          text: "Todavía no cargaste ingresos de mercadería. Entrá en Nuevo ingreso, buscá cada producto del remito y poné cuánto entró.",
        }}
      >
        {ordenados.map((i: any) => (
          <TableRow key={i.id} className={i.estado === "ANULADO" ? "opacity-50" : ""}>
            <TableCell className="text-xs">{fmtDate(i.fecha_carga)}</TableCell>
            <TableCell>{i.proveedor?.razon_social ?? "—"}</TableCell>
            <TableCell>{i.sucursal?.nombre ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs">{i.numero_remito_proveedor ?? "—"}</TableCell>

            <TableCell>
              <StatusPill tone={ESTADO_TONE[i.estado as keyof typeof ESTADO_TONE] ?? "neutral"}>
                {ESTADO_LABEL[i.estado as keyof typeof ESTADO_LABEL] ?? i.estado}
              </StatusPill>
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
                {/* Un ingreso confirmado sólo se podía anular: no había forma de
                    abrirlo para controlar qué se había cargado. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setVer(i)}
                  title="Ver qué se cargó"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
                {i.estado === "BORRADOR" && (
                  <Button size="sm" variant="ghost" asChild title="Retomar borrador">
                    <Link to="/ingresos-mercaderia/nuevo" search={{ id: i.id }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
                {cu?.isAdmin && i.estado === "CONFIRMADO" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAnular(i)}
                    title="Anular ingreso"
                  >
                    <Ban className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {ver && (
        <DetalleIngreso
          ingreso={ver}
          isAdmin={!!cu?.isAdmin}
          onClose={() => setVer(null)}
          onCorregir={(items) => {
            setCorregir({ ingreso: ver, items });
            setVer(null);
          }}
        />
      )}

      {corregir && (
        <DialogoCorregirIngreso
          ingreso={corregir.ingreso}
          items={corregir.items}
          onClose={() => {
            setVer(corregir.ingreso);
            setCorregir(null);
          }}
          onSuccess={() => {
            setVer(corregir.ingreso);
            setCorregir(null);
          }}
        />
      )}

      <AlertDialog open={!!anular} onOpenChange={(v) => !v && setAnular(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anular ingreso de mercadería</AlertDialogTitle>
            <AlertDialogDescription>
              Se va a anular el ingreso del remito {anular?.numero_remito_proveedor ?? ""} de{" "}
              {anular?.proveedor?.razon_social}. Esto revierte el stock que había sumado. Si ya se
              vendió parte de esa mercadería, no se podrá anular.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => anular && anularM.mutate(anular.id)}
              disabled={anularM.isPending}
            >
              Anular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
