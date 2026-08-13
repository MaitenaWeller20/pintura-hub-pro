import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
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
import { TableRow, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { fmtDocumento } from "@/lib/documento";
import { montoEnLetras } from "@/lib/letras";
import { toast } from "sonner";
import { Download, Plus, Loader2 } from "lucide-react";
import jsPDF from "jspdf";

export const Route = createFileRoute("/_authenticated/pagos-proveedores")({
  ssr: false,
  component: PagosProveedores,
});

// Pagos a PROVEEDORES — la plata que SALE.
//
// Ojo con el nombre: /pagos es la plata que ENTRA de los clientes. Son cosas
// opuestas con nombres parecidos, y por eso el ítem del menú dice "Pagos a
// proveedores" completo.
//
// "Casi siempre son cuenta corriente y lo pagan después. Compraron a Quimex 4
// millones y no se lo pagan en ese momento. Tiene que haber en algún lugar
// registrar cuánto le van pagando."
// Ver docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md §4

function PagosProveedores() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [abrirPago, setAbrirPago] = useState(false);

  const { data: proveedores = [] } = useQuery({
    queryKey: ["proveedores-activos"],
    queryFn: async () =>
      ((
        await supabase
          .from("proveedores")
          .select("id, razon_social, cuit_dni")
          .eq("activo", true)
          .order("razon_social")
      ).data ?? []) as any[],
  });

  const { data: sucursales = [] } = useQuery({
    queryKey: ["sucursales"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("id, nombre").order("numero")).data ??
        []) as any[],
  });

  const { data: pagos = [], isLoading } = useQuery({
    queryKey: ["pagos-proveedores"],
    queryFn: async () =>
      ((
        await supabase
          .from("proveedor_pagos")
          .select("*, proveedor:proveedores(razon_social, cuit_dni), sucursal:sucursales(nombre)")
          .order("created_at", { ascending: false })
          .limit(200)
      ).data ?? []) as any[],
  });

  // El saldo sale de la vista `proveedor_cc_saldos`, que suma en la BASE.
  //
  // Sumar los movimientos en el cliente parece más simple y es un bug: PostgREST
  // corta en 1000 filas sin avisar, y un DEBITO por compra más un CREDITO por
  // pago llegan a mil en menos de un año. Reproducido con 1204 movimientos: la
  // pantalla decía "debés $4.626" cuando el saldo real era $4.830.
  //
  // La vista existe desde 20260715150000 y su comentario dice textual: "el
  // frontend sumaba los movimientos en el cliente, lo que podía truncarse por el
  // límite de filas de PostgREST". Reimplementarlo era repetir un bug ya resuelto.
  const { data: saldosRows = [] } = useQuery({
    queryKey: ["proveedor-cc-saldos"],
    queryFn: async () =>
      ((await supabase.from("proveedor_cc_saldos").select("*")).data ?? []) as any[],
  });
  const saldos = useMemo(
    () => new Map(saldosRows.map((r: any) => [r.proveedor_id, r])),
    [saldosRows],
  );

  const { data: fiscal } = useQuery({
    queryKey: ["fiscal-publica"],
    queryFn: async () =>
      (await supabase.from("fiscal_config_publica").select("*").maybeSingle()).data,
  });

  // El recibo se arma con lo que quedó GUARDADO en el pago (número y saldo
  // posterior), no con el saldo de hoy: un comprobante que cambia solo no sirve
  // como comprobante.
  const descargar = (p: any) => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(fiscal?.razon_social ?? "Comprobante de pago", 14, 16);
    doc.setFontSize(9);
    let y = 22;
    if (fiscal?.cuit) {
      doc.text(`CUIT: ${fiscal.cuit}`, 14, y);
      y += 5;
    }
    if (fiscal?.domicilio_fiscal) {
      doc.text(String(fiscal.domicilio_fiscal), 14, y);
      y += 5;
    }
    if (p.sucursal?.nombre) {
      doc.text(`Sucursal: ${p.sucursal.nombre}`, 14, y);
      y += 5;
    }

    doc.setFontSize(14);
    doc.text("RECIBO DE PAGO A PROVEEDOR", 14, y + 6);
    // Un recibo de un pago anulado que no dice que está anulado es un papel que
    // prueba algo que no pasó.
    if (p.estado === "ANULADO") {
      doc.setTextColor(200, 0, 0);
      doc.text("ANULADO", 150, y + 6);
      doc.setTextColor(0, 0, 0);
    }
    doc.setFontSize(10);
    doc.text(`N° ${p.numero ?? "—"}`, 14, y + 13);
    doc.text(`Fecha: ${fmtDateTime(p.created_at)}`, 90, y + 13);

    y += 24;
    doc.setFontSize(10);
    doc.text(`Proveedor: ${p.proveedor?.razon_social ?? "—"}`, 14, y);
    y += 6;
    if (p.proveedor?.cuit_dni) {
      doc.text(`CUIT: ${fmtDocumento(p.proveedor.cuit_dni)}`, 14, y);
      y += 6;
    }
    doc.text(`Forma de pago: ${formaPagoLabel[p.forma_pago] ?? p.forma_pago}`, 14, y);
    y += 8;

    doc.setFontSize(13);
    doc.text(`Importe: ${fmtMoney(p.monto)}`, 14, y);
    y += 7;
    doc.setFontSize(9);
    doc.text(`Son: ${montoEnLetras(Number(p.monto))}`, 14, y);
    y += 8;

    if (p.saldo_posterior != null) {
      doc.setFontSize(10);
      doc.text(`Saldo del proveedor después de este pago: ${fmtMoney(p.saldo_posterior)}`, 14, y);
      y += 8;
    }

    // Este sistema emite comprobantes fiscales de verdad. Un papel con un importe
    // que se pueda confundir con una factura es un problema con AFIP, no un
    // detalle de diseño.
    doc.setFontSize(8);
    doc.text("Comprobante interno de pago. NO válido como factura.", 14, y + 6);
    doc.text(
      `Registrado por: ${cu?.profile?.nombre_completo ?? cu?.profile?.username ?? ""}`,
      14,
      y + 11,
    );

    doc.save(`recibo-${p.numero ?? p.id.slice(0, 8)}.pdf`);
  };

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pagos a proveedores"
        subtitle="La plata que sale para pagarle a los proveedores"
        actions={
          <Button onClick={() => setAbrirPago(true)}>
            <Plus className="h-4 w-4 mr-1" /> Registrar pago
          </Button>
        }
      />

      <SectionCard title="Cuánto se le debe a cada uno">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {proveedores.length === 0 && (
            <p className="text-sm text-muted-foreground">No hay proveedores cargados.</p>
          )}
          {proveedores.map((p: any) => {
            const s = saldos.get(p.id);
            if (!s) return null;
            const debe = Number(s.total_debe ?? 0);
            const pago = Number(s.total_pagado ?? 0);
            const saldo = Number(s.saldo ?? 0);
            if (debe === 0 && pago === 0) return null;
            return (
              <div key={p.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">{p.razon_social}</p>
                <p className="text-xs text-muted-foreground">
                  Compraste {fmtMoney(debe)} · pagaste {fmtMoney(pago)}
                </p>
                <p
                  className={`text-lg font-mono font-semibold ${saldo > 0 ? "text-warning" : "text-success"}`}
                >
                  {saldo > 0 ? `Debés ${fmtMoney(saldo)}` : "Al día"}
                </p>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <DataTable
        columns={["N°", "Fecha", "Proveedor", "Origen", "Forma de pago", "Monto", "Estado", ""]}
        loading={isLoading}
        isEmpty={pagos.length === 0}
        empty={{ text: "Todavía no se registró ningún pago a proveedores." }}
      >
        {pagos.map((p: any) => (
          <TableRow key={p.id}>
            <TableCell className="font-mono text-xs">{p.numero ?? "—"}</TableCell>
            <TableCell className="text-xs">{fmtDateTime(p.created_at)}</TableCell>
            <TableCell>{p.proveedor?.razon_social ?? "—"}</TableCell>
            <TableCell className="text-xs">
              {formaPagoLabel[p.forma_pago] ?? p.forma_pago}
            </TableCell>
            <TableCell className="font-mono">{fmtMoney(p.monto)}</TableCell>
            <TableCell>
              {p.estado === "ANULADO" ? (
                <StatusPill tone="danger">Anulado</StatusPill>
              ) : (
                <StatusPill tone="success">OK</StatusPill>
              )}
            </TableCell>
            <TableCell>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => descargar(p)}
                  title="Descargar recibo"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      <DialogoPago
        open={abrirPago}
        onClose={() => setAbrirPago(false)}
        proveedores={proveedores}
        sucursales={sucursales}
        esAdmin={cu.isAdmin}
        sucursalPropia={cu.sucursal?.id ?? ""}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["pagos-proveedores"] });
          qc.invalidateQueries({ queryKey: ["proveedor-cc-saldos"] });
          setAbrirPago(false);
        }}
      />
    </div>
  );
}

function DialogoPago({
  open,
  onClose,
  proveedores,
  sucursales,
  esAdmin,
  sucursalPropia,
  onDone,
}: any) {
  const [proveedorId, setProveedorId] = useState("");
  const [monto, setMonto] = useState<number | null>(null);
  const [forma, setForma] = useState("EFECTIVO");
  // Un admin puede no tener sucursal propia, y la plata sale de UNA caja. Sin
  // esto el diálogo mandaba "" y la RPC fallaba con un error incomprensible.
  const [sucursalId, setSucursalId] = useState(sucursalPropia);

  const m = useMutation({
    mutationFn: async () => {
      if (!proveedorId) throw new Error("Elegí el proveedor.");
      if (!sucursalId) throw new Error("Elegí de qué sucursal sale la plata.");
      if (!(Number(monto) > 0)) throw new Error("El monto tiene que ser mayor a cero.");
      const { error } = await supabase.rpc("registrar_pago_proveedor", {
        p_proveedor_id: proveedorId,
        p_sucursal_id: sucursalId,
        p_monto: Number(monto),
        p_forma_pago: forma,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Pago registrado. Ya podés descargar el recibo.");
      setProveedorId("");
      setMonto(null);
      onDone();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago a proveedor</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Proveedor *</Label>
            <Select value={proveedorId} onValueChange={setProveedorId}>
              <SelectTrigger data-testid="pago-proveedor">
                <SelectValue placeholder="Elegí…" />
              </SelectTrigger>
              <SelectContent>
                {proveedores.map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.razon_social}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {esAdmin && (
            <div>
              <Label>
                Sucursal * <span className="text-xs text-muted-foreground">(de qué caja sale)</span>
              </Label>
              <Select value={sucursalId} onValueChange={setSucursalId}>
                <SelectTrigger data-testid="pago-sucursal">
                  <SelectValue placeholder="Elegí…" />
                </SelectTrigger>
                <SelectContent>
                  {(sucursales ?? []).map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Monto *</Label>
            <NumberInput value={monto} onValueChange={setMonto} />
          </div>
          <div>
            <Label>Forma de pago</Label>
            <Select value={forma} onValueChange={setForma}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "EFECTIVO",
                  "TRANSFERENCIA",
                  "CHEQUE",
                  "TARJETA_DEBITO",
                  "TARJETA_CREDITO",
                  "MERCADO_PAGO",
                ].map((f) => (
                  <SelectItem key={f} value={f}>
                    {formaPagoLabel[f] ?? f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            La plata sale de la caja del día. El pago baja la deuda con el proveedor y queda con su
            número de recibo.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending} data-testid="confirmar-pago">
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Registrar pago
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
