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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Plus, Ban } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/compras/")({
  component: ComprasPage,
});

function ComprasPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [anular, setAnular] = useState<any>(null);

  const { data: compras = [], isLoading } = useQuery({
    queryKey: ["compras"],
    queryFn: async () => ((await supabase.from("compras")
      .select("*, proveedor:proveedores(razon_social)")
      .order("fecha_carga", { ascending: false }).limit(200)).data ?? []) as any[],
  });

  const anularM = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("anular_compra", { p_compra_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Compra anulada"); qc.invalidateQueries({ queryKey: ["compras"] }); setAnular(null); },
    onError: (e: any) => { toast.error(e.message); setAnular(null); },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Compras"
        subtitle={`${compras.length} comprobantes`}
        actions={<Button asChild><Link to="/compras/nueva"><Plus className="h-4 w-4 mr-1" /> Nueva compra</Link></Button>}
      />

      <DataTable
        columns={["Fecha", "Proveedor", "Comprobante", "Condición", "Total", "Estado", ""]}
        loading={isLoading}
        isEmpty={compras.length === 0}
        empty={{ text: "Todavía no registraste compras." }}
      >
        {compras.map((c: any) => (
          <TableRow key={c.id} className={c.estado === "ANULADA" ? "opacity-50" : ""}>
            <TableCell className="text-xs">{fmtDate(c.fecha_comprobante)}</TableCell>
            <TableCell>{c.proveedor?.razon_social ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs">{c.tipo_comprobante} {c.numero_comprobante}</TableCell>
            <TableCell>
              {c.condicion === "CTA_CTE"
                ? <StatusPill tone="warning">Cta Cte</StatusPill>
                : <span className="text-xs text-muted-foreground">Contado</span>}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{fmtMoney(c.total)}</TableCell>
            <TableCell>
              {c.estado === "ANULADA"
                ? <StatusPill tone="danger">Anulada</StatusPill>
                : <StatusPill tone="success">Activa</StatusPill>}
            </TableCell>
            <TableCell>
              {cu?.isAdmin && c.estado === "ACTIVA" && (
                <Button size="sm" variant="ghost" onClick={() => setAnular(c)} title="Anular compra">
                  <Ban className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      <AlertDialog open={!!anular} onOpenChange={(v) => !v && setAnular(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anular compra</AlertDialogTitle>
            <AlertDialogDescription>
              Se va a anular {anular?.tipo_comprobante} {anular?.numero_comprobante} de {anular?.proveedor?.razon_social}.
              Esto revierte el stock y {anular?.condicion === "CTA_CTE" ? "la deuda con el proveedor" : "el pago de la caja"}.
              Si ya se vendió parte de esa mercadería, no se podrá anular.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => anular && anularM.mutate(anular.id)} disabled={anularM.isPending}>
              Anular
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
