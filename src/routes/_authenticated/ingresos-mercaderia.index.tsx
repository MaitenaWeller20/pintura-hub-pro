import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
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
import { Plus, Ban, Pencil, Eye } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/ingresos-mercaderia/")({
  component: IngresosPage,
});

/**
 * Qué se cargó en un ingreso.
 *
 * May: "me figura confirmado pero no puedo verlo... estaría bueno que tenga una
 * solapita que pueda ver lo que ingresé para ver si lo ingresé bien, como para
 * un control". Antes un ingreso confirmado sólo ofrecía anularlo.
 *
 * Es de sólo lectura a propósito. Un ingreso confirmado YA movió el stock:
 * editarle las cantidades por atrás dejaría el inventario diciendo una cosa y
 * lo que entró físicamente otra, sin rastro. Para corregirlo está anular y
 * volver a cargar, que sí deja historia.
 */
function DetalleIngreso({ ingreso, onClose }: { ingreso: any; onClose: () => void }) {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["ingreso-items", ingreso.id],
    queryFn: async () =>
      ((
        await supabase
          .from("ingreso_mercaderia_items")
          .select(
            "id, linea, codigo, descripcion, cantidad, codigo_proveedor, descripcion_proveedor",
          )
          .eq("ingreso_id", ingreso.id)
          .order("linea")
      ).data ?? []) as any[],
  });

  const total = items.reduce((a, i) => a + Number(i.cantidad || 0), 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Ingreso de {ingreso.proveedor?.razon_social ?? "—"}
            {ingreso.numero_remito_proveedor ? ` — remito ${ingreso.numero_remito_proveedor}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Estado</p>
            <StatusPill tone={ESTADO_TONE[ingreso.estado as keyof typeof ESTADO_TONE] ?? "neutral"}>
              {ESTADO_LABEL[ingreso.estado as keyof typeof ESTADO_LABEL] ?? ingreso.estado}
            </StatusPill>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cargado</p>
            <p>{fmtDate(ingreso.fecha_carga)}</p>
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
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Cargando…
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

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {items.length} {items.length === 1 ? "producto" : "productos"} · {total} unidades
          </span>
          {ingreso.estado === "CONFIRMADO" && (
            <span className="text-xs text-muted-foreground">
              Ya sumó al stock. Para corregir una cantidad hay que anularlo y volver a cargarlo.
            </span>
          )}
        </div>

        <DialogFooter>
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

  const { data: ingresos = [], isLoading } = useQuery({
    queryKey: ["ingresos-mercaderia"],
    queryFn: async () =>
      ((
        await supabase
          .from("ingresos_mercaderia")
          .select("*, proveedor:proveedores(razon_social)")
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
        columns={["Fecha", "Proveedor", "Remito", "Estado", ""]}
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

      {ver && <DetalleIngreso ingreso={ver} onClose={() => setVer(null)} />}

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
