import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ClientePicker } from "@/components/cliente-picker";
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
import { fmtMoney, fmtDate, formaPagoLabel } from "@/lib/format";
import { conIva } from "@/lib/fiscal/iva";
import { toast } from "sonner";
import { ArrowLeft, Printer, Loader2, AlertTriangle, Pencil } from "lucide-react";
import jsPDF from "jspdf";
import { dibujarEncabezado, traerLogo, SELECT_SUCURSAL_IMPRESA } from "@/lib/impresos/encabezado";
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
          .select(`*, cliente:clientes(razon_social, cuit_dni), sucursal:sucursales(${SELECT_SUCURSAL_IMPRESA})`)
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

  const imprimir = async () => {
    if (!p) return;
    // El logo se pide ACÁ y no con el resto: son hasta 100 KB de data URL y no
    // tienen por qué viajar cada vez que se abre un presupuesto.
    const logo = await traerLogo(supabase, p.sucursal?.emisor?.id);
    const sucursal = { ...p.sucursal, emisor: { ...p.sucursal?.emisor, logo } };
    const doc = new jsPDF();
    // El encabezado sale del emisor de la SUCURSAL, no de `fiscal_config`: son
    // dos razones sociales distintas y la config global está vacía, por eso el
    // presupuesto salía pelado. Devuelve la Y donde termina para que lo de abajo
    // no se le monte encima con un logo o una razón social larga.
    const y = dibujarEncabezado(doc, sucursal, { y: 16 });

    doc.setFontSize(18);
    doc.text("PRESUPUESTO", 14, y + 8);
    doc.setFontSize(10);
    doc.text(`N° ${p.numero}`, 14, y + 15);
    doc.text(`Fecha: ${fmtDate(p.fecha)}`, 90, y + 15);
    if (p.validez_hasta) doc.text(`Válido hasta: ${fmtDate(p.validez_hasta)}`, 140, y + 15);

    doc.text(`Cliente: ${p.cliente?.razon_social ?? p.nombre_cliente ?? "—"}`, 14, y + 22);

    autoTable(doc, {
      startY: y + 28,
      // Precios finales, con IVA: es lo que se le cotiza al cliente.
      head: [["Código", "Producto", "Cant.", "Precio", "Desc.", "Subtotal"]],
      body: items.map((i: any) => [
        i.codigo,
        i.descripcion,
        String(Number(i.cantidad)),
        fmtMoney(conIva(i.precio_sin_iva, i.iva_porcentaje)),
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
                {/* Sólo con el presupuesto ABIERTO: uno convertido ya es una
                    venta y uno anulado está muerto. La RPC lo rechaza igual. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate({ to: "/presupuestos/editar/$id", params: { id: p.id } })}
                  data-testid="editar-presupuesto"
                >
                  <Pencil className="h-4 w-4 mr-1" /> Editar
                </Button>
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
            Este presupuesto ya se convirtió en una venta. Buscala en{" "}
            <Link to="/ventas" className="underline">
              Ventas
            </Link>{" "}
            por <strong>{p.numero}</strong>: la venta lleva ese número en sus observaciones.
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
                {/* Los precios van CON IVA: es el número que se le dice al
                    cliente. Mostrar el neto y el IVA por separado confundía, y
                    hay clientes a los que no se les quiere mostrar el desglose.
                    Lo guardado sigue siendo neto, que es lo que factura. */}
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
                    {fmtMoney(conIva(i.precio_lista_sin_iva, i.iva_porcentaje))}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(i.descuento_porcentaje) > 0
                      ? `${Number(i.descuento_porcentaje)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtMoney(conIva(i.precio_sin_iva, i.iva_porcentaje))}
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
          <div className="text-right">
            <p className="text-xl font-bold font-mono">{fmtMoney(p.total)}</p>
            <p className="text-[11px] text-muted-foreground">IVA incluido</p>
          </div>
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
  // El pago se registraba SIEMPRE como efectivo. El arqueo compara el bucket
  // EFECTIVO contra la plata contada, así que cada conversión cobrada por
  // transferencia dejaba un faltante de caja por ese monto.
  const [formaPago, setFormaPago] = useState("EFECTIVO");

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
            : ([{ forma_pago: formaPago, monto: Number(presupuesto.total) }] as any),
        // La clave de idempotencia la deriva la RPC del propio presupuesto:
        // mandarla desde acá permitía que dos presupuestos compartieran venta.
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Venta creada con los precios del presupuesto.");
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
            <ClientePicker
              value={clienteId}
              onChange={setClienteId}
              testId="conv-cliente"
              placeholder="Elegí…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Comprobante</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                {/* Sólo facturas. REMITO y FAC_INTERNA_CTA_CTE tienen condición
                    FORZADA en crear_venta (remito va siempre a cuenta corriente e
                    ignora los pagos; la factura interna va siempre a contado), así
                    que ofrecerlas acá dejaba elegir combinaciones que el servidor
                    pisa: un pago que se ignora, o una venta sin caja ni deuda.
                    Para esos comprobantes está el flujo normal de Ventas. */}
                <SelectContent>
                  <SelectItem value="FACTURA_B">Factura B</SelectItem>
                  <SelectItem value="FACTURA_A">Factura A</SelectItem>
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
          {condicion === "CONTADO" && (
            <div>
              <Label>Cómo paga</Label>
              <Select value={formaPago} onValueChange={setFormaPago}>
                <SelectTrigger data-testid="conv-forma-pago">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "EFECTIVO",
                    "TRANSFERENCIA",
                    "TARJETA_DEBITO",
                    "TARJETA_CREDITO",
                    "MERCADO_PAGO",
                    "CHEQUE",
                  ].map((f) => (
                    <SelectItem key={f} value={f}>
                      {formaPagoLabel[f] ?? f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
