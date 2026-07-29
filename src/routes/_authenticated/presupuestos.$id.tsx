import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { fmtMoney, fmtDate } from "@/lib/format";
import { uuidv4 } from "@/lib/uuid";
import { toast } from "sonner";
import { ArrowLeft, Printer, Loader2, AlertTriangle } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/presupuestos/$id")({
  component: DetallePresupuesto,
});

function DetallePresupuesto() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: cu } = useCurrentUser();
  const [abrirConv, setAbrirConv] = useState(false);

  const { data: p } = useQuery({
    queryKey: ["presupuesto", id],
    queryFn: async () =>
      (
        await supabase
          .from("presupuestos")
          .select("*, cliente:clientes(razon_social, cuit_dni), sucursal:sucursales(nombre)")
          .eq("id", id)
          .maybeSingle()
      ).data,
  });
  const { data: items = [] } = useQuery({
    queryKey: ["presupuesto-items", id],
    queryFn: async () =>
      ((await supabase.from("presupuesto_items").select("*").eq("presupuesto_id", id)).data ??
        []) as any[],
  });
  const { data: fiscal } = useQuery({
    queryKey: ["fiscal-publica"],
    queryFn: async () =>
      (await supabase.from("fiscal_config_publica").select("*").maybeSingle()).data,
  });

  const vencido =
    p?.estado === "ABIERTO" &&
    p?.validez_hasta &&
    new Date(p.validez_hasta) < new Date(new Date().toDateString());

  const imprimir = () => {
    if (!p) return;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(fiscal?.razon_social ?? "Presupuesto", 14, 16);
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

    doc.setFontSize(18);
    doc.text("PRESUPUESTO", 14, y + 8);
    doc.setFontSize(10);
    doc.text(`N° ${p.numero}`, 14, y + 15);
    doc.text(`Fecha: ${fmtDate(p.fecha)}`, 90, y + 15);
    if (p.validez_hasta) doc.text(`Válido hasta: ${fmtDate(p.validez_hasta)}`, 140, y + 15);

    doc.text(`Cliente: ${p.cliente?.razon_social ?? p.nombre_cliente ?? "—"}`, 14, y + 22);

    autoTable(doc, {
      startY: y + 28,
      head: [["Código", "Producto", "Cant.", "Precio", "Desc.", "Subtotal"]],
      body: items.map((i: any) => [
        i.codigo,
        i.descripcion,
        String(Number(i.cantidad)),
        fmtMoney(i.precio_sin_iva),
        Number(i.descuento_porcentaje) > 0 ? `${Number(i.descuento_porcentaje)}%` : "—",
        fmtMoney(i.subtotal_con_iva),
      ]),
      styles: { fontSize: 8 },
    });

    const fin = (doc as any).lastAutoTable?.finalY ?? y + 40;
    doc.setFontSize(12);
    doc.text(`TOTAL: ${fmtMoney(p.total)}`, 14, fin + 10);

    // Este sistema emite comprobantes fiscales de verdad. Un papel con precios
    // que se pueda confundir con una factura es un problema con AFIP.
    doc.setFontSize(8);
    doc.text(
      "PRESUPUESTO — No válido como factura. Los precios pueden cambiar sin previo aviso.",
      14,
      fin + 20,
    );
    if (p.observaciones) doc.text(String(p.observaciones), 14, fin + 26);

    doc.save(`presupuesto-${p.numero}.pdf`);
  };

  const anularM = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("anular_presupuesto", { p_presupuesto_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Presupuesto anulado");
      qc.invalidateQueries({ queryKey: ["presupuesto", id] });
      qc.invalidateQueries({ queryKey: ["presupuestos"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!cu || !p) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Presupuesto ${p.numero}`}
        subtitle={p.cliente?.razon_social ?? p.nombre_cliente ?? "Sin cliente asignado"}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/presupuestos" })}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button variant="outline" size="sm" onClick={imprimir}>
              <Printer className="h-4 w-4 mr-1" /> Imprimir PDF
            </Button>
            {p.estado === "ABIERTO" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => anularM.mutate()}
                  disabled={anularM.isPending}
                >
                  Anular
                </Button>
                <Button onClick={() => setAbrirConv(true)} data-testid="convertir">
                  Convertir en venta
                </Button>
              </>
            )}
          </>
        }
      />

      {p.estado === "CONVERTIDO" && (
        <SectionCard>
          <p className="text-sm">
            Este presupuesto ya se convirtió en una venta.{" "}
            {p.venta_id && (
              <Link to="/ventas" className="underline">
                Ver en Ventas
              </Link>
            )}
          </p>
        </SectionCard>
      )}

      {vencido && (
        <SectionCard>
          <div className="flex gap-2 items-start text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
            <p>
              Este presupuesto venció el <strong>{fmtDate(p.validez_hasta)}</strong>. Se puede
              convertir igual —respetar un precio viejo es decisión del negocio— pero conviene
              revisar los precios antes.
            </p>
          </div>
        </SectionCard>
      )}

      <div className="rounded-2xl border border-border overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cant.</TableHead>
                <TableHead className="text-right">Precio de lista</TableHead>
                <TableHead className="text-right">Desc.</TableHead>
                <TableHead className="text-right">Precio</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i: any) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.codigo}</TableCell>
                  <TableCell>{i.descripcion}</TableCell>
                  <TableCell className="text-right">{Number(i.cantidad)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmtMoney(i.precio_lista_sin_iva)}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(i.descuento_porcentaje) > 0
                      ? `${Number(i.descuento_porcentaje)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtMoney(i.precio_sin_iva)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {fmtMoney(i.subtotal_con_iva)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <SectionCard>
        <div className="flex justify-between items-center">
          <div className="text-sm text-muted-foreground">
            {p.estado === "ABIERTO" && (
              <>
                <StatusPill tone="success">abierto</StatusPill>{" "}
                <span className="ml-2">
                  Los productos <strong>no salieron del stock</strong> y el monto{" "}
                  <strong>no está cobrado</strong>.
                </span>
              </>
            )}
          </div>
          <p className="text-xl font-bold font-mono">{fmtMoney(p.total)}</p>
        </div>
      </SectionCard>

      <DialogoConvertir
        open={abrirConv}
        onClose={() => setAbrirConv(false)}
        presupuesto={p}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["presupuesto", id] });
          qc.invalidateQueries({ queryKey: ["presupuestos"] });
          setAbrirConv(false);
        }}
      />
    </div>
  );
}

function DialogoConvertir({ open, onClose, presupuesto, onDone }: any) {
  const [clienteId, setClienteId] = useState(presupuesto?.cliente_id ?? "");
  const [tipo, setTipo] = useState("FACTURA_B");
  const [condicion, setCondicion] = useState("CONTADO");
  const [clave, setClave] = useState(() => uuidv4());

  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-activos"],
    queryFn: async () =>
      ((
        await supabase
          .from("clientes")
          .select("id, razon_social")
          .eq("activo", true)
          .order("razon_social")
          .limit(500)
      ).data ?? []) as any[],
  });

  const m = useMutation({
    mutationFn: async () => {
      if (!clienteId) throw new Error("Elegí el cliente.");
      const { error } = await supabase.rpc("convertir_presupuesto_en_venta", {
        p_presupuesto_id: presupuesto.id,
        p_cliente_id: clienteId,
        p_tipo_comprobante: tipo as any,
        p_condicion_venta: condicion as any,
        p_pagos:
          condicion === "CTA_CTE"
            ? []
            : ([{ forma_pago: "EFECTIVO", monto: Number(presupuesto.total) }] as any),
        p_idempotency_key: clave,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Venta creada con los precios del presupuesto.");
      setClave(uuidv4());
      onDone();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convertir en venta</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Se va a crear una venta con{" "}
            <strong>los productos y los precios de este presupuesto</strong>, aunque los precios del
            catálogo hayan cambiado. Recién ahí se descuenta el stock y entra la plata.
          </p>
          <div>
            <Label>Cliente *</Label>
            <Select value={clienteId} onValueChange={setClienteId}>
              <SelectTrigger data-testid="conv-cliente">
                <SelectValue placeholder="Elegí…" />
              </SelectTrigger>
              <SelectContent>
                {clientes.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.razon_social}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Comprobante</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["FACTURA_B", "FACTURA_A", "REMITO", "FAC_INTERNA_CTA_CTE"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Condición</Label>
              <Select value={condicion} onValueChange={setCondicion}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE">Cuenta corriente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending} data-testid="conv-confirmar">
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Crear la venta por {fmtMoney(presupuesto?.total ?? 0)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
