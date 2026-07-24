import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { TableRow, TableCell } from "@/components/ui/table";
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
import { Plus, Ban, Pencil } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/ingresos-mercaderia/")({
  component: IngresosPage,
});

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
        columns={["Fecha", "Proveedor", "Remito", "Extracción", "Estado", ""]}
        loading={isLoading}
        isEmpty={ingresos.length === 0}
        empty={{
          text: "Todavía no cargaste ingresos de mercadería. Subí el remito del proveedor y el sistema lo lee solo.",
        }}
      >
        {ordenados.map((i: any) => (
          <TableRow key={i.id} className={i.estado === "ANULADO" ? "opacity-50" : ""}>
            <TableCell className="text-xs">{fmtDate(i.fecha_carga)}</TableCell>
            <TableCell>{i.proveedor?.razon_social ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs">{i.numero_remito_proveedor ?? "—"}</TableCell>
            <TableCell>
              {i.extraccion_estado === "ERROR" ? (
                <StatusPill tone="danger" data-testid="extraccion-error">
                  Error
                </StatusPill>
              ) : i.extraccion_estado === "PENDIENTE" ? (
                <StatusPill tone="neutral">Pendiente</StatusPill>
              ) : (
                <span className="text-xs text-muted-foreground">OK</span>
              )}
            </TableCell>
            <TableCell>
              <StatusPill tone={ESTADO_TONE[i.estado as keyof typeof ESTADO_TONE] ?? "neutral"}>
                {ESTADO_LABEL[i.estado as keyof typeof ESTADO_LABEL] ?? i.estado}
              </StatusPill>
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
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
