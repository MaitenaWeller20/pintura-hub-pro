/** Cuenta Corriente: lista clientes habilitados, su deuda y permite cobrar. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney, fmtDate, formaPagoLabel } from "@/lib/format";
import { coincideDocumento, fmtDocumento } from "@/lib/documento";
import { toast } from "sonner";
import { Wallet, Receipt, ChevronRight, Loader2 } from "lucide-react";
import { uuidv4 } from "@/lib/uuid";
import { useServerFn } from "@tanstack/react-start";
import { registrarCobranza } from "@/lib/cobranzas.functions";

export const Route = createFileRoute("/_authenticated/cuentas-corrientes")({
  // Permite entrar directo a la cuenta de un cliente: /cuentas-corrientes?cliente=<id>
  validateSearch: (search: Record<string, unknown>): { cliente?: string } => ({
    cliente: typeof search.cliente === "string" ? search.cliente : undefined,
  }),
  component: CtaCtePage,
});

function CtaCtePage() {
  const qc = useQueryClient();
  const { cliente: clienteParam } = Route.useSearch();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<any>(null);
  const [openPago, setOpenPago] = useState(false);

  // Saldos por cliente, derivados del libro de movimientos (Σ débitos − Σ créditos).
  // Una sola consulta a la vista: no se recalcula sumando ventas y cobranzas.
  const { data: saldos = [] } = useQuery({
    queryKey: ["ctacte-saldos"],
    queryFn: async () => ((await supabase.from("cuenta_corriente_saldos")
      .select("*").order("razon_social")).data ?? []) as any[],
  });

  /**
   * Filtro por saldo, para llegar a "a quién hay que cobrarle" sin leer la lista
   * entera. Pedido de Leo.
   *
   * El default es TODOS y no "con deuda": esta pantalla es la cuenta corriente
   * general, no una de cobranzas, y esconder por omisión a los que están en cero
   * hace que parezca que el cliente desapareció.
   *
   * El corte va en 0 y no en 0,01. Los movimientos son numeric(14,2), así que no
   * hay fracciones de centavo que amortiguar; con 0,01 un saldo de exactamente
   * un centavo se mostraría como $0,01 y no entraría en ninguno de los dos
   * filtros. Se redondea antes de comparar por las dudas.
   */
  const [saldoFiltro, setSaldoFiltro] = useState<"todos" | "deuda" | "favor">("todos");

  const filtered = useMemo(
    () =>
      saldos.filter((c: any) => {
        if (!coincideDocumento(c, q)) return false;
        const saldo = Math.round(Number(c.saldo) * 100) / 100;
        if (saldoFiltro === "deuda") return saldo > 0;
        if (saldoFiltro === "favor") return saldo < 0;
        return true;
      }),
    [saldos, q, saldoFiltro],
  );

  // Lo que suma lo que quedó a la vista: es el número que se busca al entrar a
  // cobrar. En "a favor" se muestra en positivo, que un total negativo ahí no
  // dice nada.
  const totalFiltrado = useMemo(
    () => filtered.reduce((a: number, c: any) => a + Number(c.saldo), 0),
    [filtered],
  );

  // Si venimos de Clientes con ?cliente=<id>, abrimos su detalle automáticamente.
  // Si el cliente todavía no tiene movimientos (no está en la vista de saldos),
  // traemos sus datos básicos de la tabla clientes.
  useEffect(() => {
    if (!clienteParam || sel) return;
    const found = saldos.find((c: any) => c.cliente_id === clienteParam);
    if (found) {
      setSel({ id: found.cliente_id, razon_social: found.razon_social, cuit_dni: found.cuit_dni });
      return;
    }
    let cancel = false;
    supabase.from("clientes").select("id, razon_social, cuit_dni").eq("id", clienteParam).maybeSingle()
      .then(({ data }) => { if (!cancel && data) setSel({ id: data.id, razon_social: data.razon_social, cuit_dni: data.cuit_dni }); });
    return () => { cancel = true; };
  }, [clienteParam, saldos, sel]);

  return (
    <div>
      <PageHeader title="Cuentas Corrientes" subtitle="Deuda por cliente y por proveedor." />

      <Tabs defaultValue="clientes">
        <TabsList className="mb-4 h-auto w-full flex-wrap justify-start gap-1 sm:w-fit sm:flex-nowrap">
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          {/* Tab aparte y no mezclado con el saldo de cuenta corriente, a
              propósito: una cuenta corriente es una cuenta abierta con un
              cliente habilitado; esto es UN comprobante que quedó a medias, y
              puede ser de Consumidor Final. Sumarlos en la misma columna haría
              que "Saldo" signifique dos cosas. */}
          <TabsTrigger value="pendientes">Ventas a medio cobrar</TabsTrigger>
        </TabsList>

        <TabsContent value="clientes">
          <Card className="p-3 mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <Input placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
              <Select value={saldoFiltro} onValueChange={(v) => setSaldoFiltro(v as typeof saldoFiltro)}>
                <SelectTrigger className="w-44" data-testid="filtro-saldo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos</SelectItem>
                  <SelectItem value="deuda">Con deuda</SelectItem>
                  <SelectItem value="favor">Con saldo a favor</SelectItem>
                </SelectContent>
              </Select>
              {/* El total de lo que quedó a la vista: es el número que se busca
                  al entrar a cobrar. En "a favor" va en positivo. */}
              <p className="text-sm text-muted-foreground" data-testid="total-filtrado">
                {filtered.length} de {saldos.length}
                {saldoFiltro === "deuda" && ` · total a cobrar ${fmtMoney(totalFiltrado)}`}
                {saldoFiltro === "favor" && ` · total a favor ${fmtMoney(Math.abs(totalFiltrado))}`}
              </p>
            </div>
          </Card>

          <DataTable
            columns={["Cliente", "CUIT/DNI", "Debe", "Pagado", "Saldo", ""]}
            isEmpty={filtered.length === 0}
            /* Que el vacío diga POR QUÉ está vacío: si lo vació el filtro, decir
               "no hay clientes con cuenta corriente" hace pensar que se
               perdieron los datos. */
            empty={{
              text:
                saldos.length === 0
                  ? "No hay clientes con cuenta corriente."
                  : saldoFiltro === "deuda"
                    ? "Ningún cliente debe plata." + (q ? " (con esa búsqueda)" : "")
                    : saldoFiltro === "favor"
                      ? "Ningún cliente tiene saldo a favor." + (q ? " (con esa búsqueda)" : "")
                      : "Ningún cliente coincide con la búsqueda.",
              icon: <Wallet className="h-7 w-7" />,
            }}
          >
            {filtered.map((c: any) => {
              const saldo = Number(c.saldo);
              return (
                <TableRow key={c.cliente_id}>
                  <TableCell className="font-medium">{c.razon_social}</TableCell>
                  <TableCell className="font-mono text-xs">{fmtDocumento(c.cuit_dni)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtMoney(c.total_debe)}</TableCell>
                  <TableCell className="text-right font-mono text-success">{fmtMoney(c.total_pagado)}</TableCell>
                  <TableCell className={`text-right font-mono font-semibold ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : "text-muted-foreground"}`}>
                    {fmtMoney(saldo)}{saldo < -0.01 && " (a favor)"}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => setSel({ id: c.cliente_id, razon_social: c.razon_social, cuit_dni: c.cuit_dni })}>
                      <Receipt className="h-3.5 w-3.5 mr-1" /> Ver
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>
        </TabsContent>

        <TabsContent value="proveedores">
          <ProveedoresCtaCte />
        </TabsContent>

        <TabsContent value="pendientes">
          <VentasAMedioCobrar />
        </TabsContent>
      </Tabs>

      {sel && (
        <DetalleCliente cliente={sel} onClose={() => setSel(null)}
          onPagar={() => setOpenPago(true)} />
      )}
      {sel && (
        <PagoDialog open={openPago} onClose={() => setOpenPago(false)} cliente={sel}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["ctacte-saldos"] }); qc.invalidateQueries({ queryKey: ["ctacte-cliente", sel.id] }); qc.invalidateQueries({ queryKey: ["ctacte-resumen", sel.id] }); setOpenPago(false); }} />
      )}
    </div>
  );
}

/**
 * Ventas al contado que se cobraron a medias.
 *
 * Antes esta plata no se veía en ningún lado y —peor— no había forma de
 * cobrarla: la venta quedaba en PARCIAL para siempre. Ver
 * docs/superpowers/specs/2026-08-04-caja-negativa-y-saldos-de-venta-design.md
 */
function VentasAMedioCobrar() {
  const qc = useQueryClient();
  const [cobrando, setCobrando] = useState<any>(null);

  const { data: filas = [], isLoading } = useQuery({
    queryKey: ["ventas-saldo-pendiente"],
    queryFn: async () =>
      ((await supabase.from("ventas_saldo_pendiente").select("*").order("fecha", { ascending: false })).data ??
        []) as any[],
  });

  const total = filas.reduce((a: number, f: any) => a + Number(f.saldo), 0);

  return (
    <>
      <SectionCard>
        <p className="text-sm text-muted-foreground">
          Ventas al contado donde se cobró una parte y quedó un saldo. No son cuenta corriente: es{" "}
          <strong>ese comprobante</strong> el que quedó a medias.
        </p>
      </SectionCard>

      <DataTable
        columns={["Comprobante", "Fecha", "Cliente", "Sucursal", "Total", "Cobrado", "Saldo", ""]}
        loading={isLoading}
        isEmpty={filas.length === 0}
        empty={{ text: "No hay ninguna venta a medio cobrar." }}
      >
        {filas.map((f: any) => (
          <TableRow key={f.venta_id}>
            <TableCell className="font-mono text-xs">{f.numero_comprobante}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{fmtDate(f.fecha)}</TableCell>
            <TableCell>{f.cliente}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{f.sucursal_nombre}</TableCell>
            <TableCell className="text-right font-mono">{fmtMoney(f.total)}</TableCell>
            <TableCell className="text-right font-mono text-success">{fmtMoney(f.cobrado)}</TableCell>
            <TableCell className="text-right font-mono font-semibold text-destructive">
              {fmtMoney(f.saldo)}
            </TableCell>
            <TableCell>
              <Button size="sm" onClick={() => setCobrando(f)} data-testid={`cobrar-${f.numero_comprobante}`}>
                Cobrar
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {filas.length > 0 && (
        <p className="mt-2 text-right text-sm">
          Total sin cobrar: <strong className="font-mono">{fmtMoney(total)}</strong>
        </p>
      )}

      {cobrando && (
        <CobrarSaldoDialog
          venta={cobrando}
          onClose={() => setCobrando(null)}
          onSaved={() => {
            setCobrando(null);
            qc.invalidateQueries({ queryKey: ["ventas-saldo-pendiente"] });
            qc.invalidateQueries({ queryKey: ["ventas"] });
          }}
        />
      )}
    </>
  );
}

function CobrarSaldoDialog({ venta, onClose, onSaved }: any) {
  const [monto, setMonto] = useState<number | null>(Number(venta.saldo));
  const [forma, setForma] = useState("EFECTIVO");
  // Clave estable por intento: un doble click manda la misma y el backend
  // colapsa los dos en un solo cobro.
  const idem = useRef<string>(uuidv4());

  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("cobrar_saldo_venta", {
        p_venta_id: venta.venta_id,
        p_forma_pago: forma,
        p_monto: Number(monto ?? 0),
        p_detalle: {},
        p_idempotency_key: idem.current,
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    onSuccess: (r: any) => {
      idem.current = uuidv4();
      toast.success(
        r?.estado === "PAGADO"
          ? `${venta.numero_comprobante} quedó totalmente cobrada.`
          : `Cobrado. Queda un saldo de ${fmtMoney(Number(r?.saldo ?? 0))}.`,
      );
      onSaved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const excede = Number(monto ?? 0) > Number(venta.saldo) + 0.01;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cobrar {venta.numero_comprobante}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {venta.cliente} · total {fmtMoney(venta.total)} · ya cobrado {fmtMoney(venta.cobrado)}
          </p>
          <div>
            <Label>Cuánto cobrás</Label>
            <NumberInput value={monto} onValueChange={setMonto} data-testid="cobro-monto" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Saldo: <strong>{fmtMoney(venta.saldo)}</strong>. No se puede cobrar de más: el vuelto se
              da en el mostrador.
            </p>
            {excede && <p className="text-xs text-destructive">Es más que el saldo.</p>}
          </div>
          <div>
            <Label>Forma de pago</Label>
            <Select value={forma} onValueChange={setForma}>
              <SelectTrigger data-testid="cobro-forma">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO", "MERCADO_PAGO", "CHEQUE"].map(
                  (k) => (
                    <SelectItem key={k} value={k}>
                      {formaPagoLabel[k] ?? k}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={!monto || monto <= 0 || excede || m.isPending}
            data-testid="cobro-confirmar"
          >
            {m.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Cobrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Cuenta corriente de PROVEEDORES ----------------
function ProveedoresCtaCte() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<any>(null);
  const [openPago, setOpenPago] = useState(false);

  // Saldo por proveedor desde la vista (agrega en SQL: no se trunca por paginación
  // y muestra también a los proveedores con cta cte sin movimientos aún).
  const { data: saldos = [] } = useQuery({
    queryKey: ["prov-cc-saldos"],
    queryFn: async () => ((await supabase.from("proveedor_cc_saldos")
      .select("*").order("razon_social")).data ?? []).map((p: any) => ({
        proveedor_id: p.proveedor_id, razon_social: p.razon_social, cuit_dni: p.cuit_dni,
        debe: Number(p.total_debe), pagado: Number(p.total_pagado),
      })),
  });

  const filtered = useMemo(() => saldos.filter((p: any) =>
    coincideDocumento(p, q)
  ), [saldos, q]);

  return (
    <>
      <Card className="p-3 mb-4">
        <Input placeholder="Buscar proveedor…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </Card>
      <DataTable
        columns={["Proveedor", "CUIT", "Comprado", "Pagado", "Le debemos", ""]}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay proveedores con cuenta corriente.", icon: <Wallet className="h-7 w-7" /> }}
      >
        {filtered.map((p: any) => {
          const saldo = p.debe - p.pagado;
          return (
            <TableRow key={p.proveedor_id}>
              <TableCell className="font-medium">{p.razon_social}</TableCell>
              <TableCell className="font-mono text-xs">{fmtDocumento(p.cuit_dni)}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(p.debe)}</TableCell>
              <TableCell className="text-right font-mono text-success">{fmtMoney(p.pagado)}</TableCell>
              <TableCell className={`text-right font-mono font-semibold ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : "text-muted-foreground"}`}>
                {fmtMoney(saldo)}{saldo < -0.01 && " (a favor)"}
              </TableCell>
              <TableCell>
                <Button size="sm" variant="outline" onClick={() => setSel({ id: p.proveedor_id, razon_social: p.razon_social })}>
                  <Receipt className="h-3.5 w-3.5 mr-1" /> Ver
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>

      {sel && <DetalleProveedor proveedor={sel} onClose={() => setSel(null)} onPagar={() => setOpenPago(true)} />}
      {sel && <PagoProveedorDialog open={openPago} onClose={() => setOpenPago(false)} proveedor={sel}
        onSaved={() => { qc.invalidateQueries({ queryKey: ["prov-cc-saldos"] }); qc.invalidateQueries({ queryKey: ["prov-cc-mov", sel.id] }); setOpenPago(false); }} />}
    </>
  );
}

function DetalleProveedor({ proveedor, onClose, onPagar }: any) {
  const qc = useQueryClient();
  const { data: cu } = useCurrentUser();
  const { data: movs = [] } = useQuery({
    queryKey: ["prov-cc-mov", proveedor.id],
    queryFn: async () => ((await supabase.from("proveedor_cc_movimientos")
      .select("id, created_at, tipo, monto, estado, forma_pago, descripcion, pago_id")
      .eq("proveedor_id", proveedor.id)
      .order("created_at", { ascending: false })).data ?? []) as any[],
  });
  const confirmados = movs.filter((m: any) => m.estado === "CONFIRMADO");
  const debe = confirmados.filter((m: any) => m.tipo === "DEBITO").reduce((a: number, m: any) => a + Number(m.monto), 0);
  const pagado = confirmados.filter((m: any) => m.tipo === "CREDITO").reduce((a: number, m: any) => a + Number(m.monto), 0);
  const saldo = debe - pagado;

  const anularPago = useMutation({
    mutationFn: async (pagoId: string) => {
      const { error } = await supabase.rpc("anular_pago_proveedor", { p_pago_id: pagoId });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Pago anulado"); qc.invalidateQueries({ queryKey: ["prov-cc-mov", proveedor.id] }); qc.invalidateQueries({ queryKey: ["prov-cc-saldos"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{proveedor.razon_social}</span>
            <Button size="sm" onClick={onPagar}><Wallet className="h-4 w-4 mr-1" /> Registrar pago</Button>
          </DialogTitle>
        </DialogHeader>
        <SectionCard title="Resumen de la cuenta">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div><div className="text-xs text-muted-foreground">Comprado</div><div className="font-mono font-bold text-lg">{fmtMoney(debe)}</div></div>
            <div><div className="text-xs text-muted-foreground">Pagado</div><div className="font-mono font-bold text-lg text-success">{fmtMoney(pagado)}</div></div>
            <div><div className="text-xs text-muted-foreground">Le debemos</div>
              <div className={`font-mono font-bold text-lg ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : ""}`}>{fmtMoney(saldo)}{saldo < -0.01 && " a favor"}</div>
            </div>
          </div>
        </SectionCard>
        <h4 className="font-semibold">Movimientos</h4>
        <DataTable columns={["Fecha", "Detalle", "Compra", "Pago", ""]} isEmpty={movs.length === 0} empty={{ text: "Sin movimientos" }}>
          {movs.map((m: any) => {
            const anulado = m.estado === "ANULADO";
            return (
              <TableRow key={m.id} className={anulado ? "opacity-40 line-through" : ""}>
                <TableCell className="text-xs">{fmtDate(m.created_at)}</TableCell>
                <TableCell className="text-sm">
                  {m.descripcion}
                  {m.forma_pago && <span className="text-xs text-muted-foreground"> · {formaPagoLabel[m.forma_pago] ?? m.forma_pago}</span>}
                  {anulado && <span className="ml-2"><StatusPill tone="neutral">anulado</StatusPill></span>}
                </TableCell>
                <TableCell className="text-right font-mono">{m.tipo === "DEBITO" ? fmtMoney(m.monto) : "—"}</TableCell>
                <TableCell className="text-right font-mono text-success">{m.tipo === "CREDITO" ? fmtMoney(m.monto) : "—"}</TableCell>
                <TableCell>
                  {cu?.isAdmin && m.tipo === "CREDITO" && !anulado && m.pago_id && (
                    <Button size="sm" variant="ghost" onClick={() => anularPago.mutate(m.pago_id)} title="Anular pago">×</Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </DataTable>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cerrar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PagoProveedorDialog({ open, onClose, proveedor, onSaved }: any) {
  const { data: cu } = useCurrentUser();
  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const [sucId, setSucId] = useState("");
  const [monto, setMonto] = useState<number | null>(null);
  const [forma, setForma] = useState("EFECTIVO");
  const effSuc = sucId || cu?.sucursal?.id || "";

  const m = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("registrar_pago_proveedor", {
        p_proveedor_id: proveedor.id, p_sucursal_id: effSuc,
        p_monto: Number(monto || 0), p_forma_pago: forma, p_detalle: {},
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Pago registrado (sale de la caja)"); onSaved(); setMonto(null); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pagar a proveedor · {proveedor.razon_social}</DialogTitle></DialogHeader>
        <SectionCard title="Datos del pago">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {cu?.isAdmin && (
              <div className="col-span-2"><Label>Sucursal (caja de donde sale)</Label>
                <Select value={sucId} onValueChange={setSucId}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                  <SelectContent>{sucs.map((s: any) => (<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
                </Select>
              </div>
            )}
            <div><Label>Monto *</Label><NumberInput value={monto} onValueChange={setMonto} /></div>
            <div><Label>Forma de pago *</Label>
              <Select value={forma} onValueChange={setForma}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(formaPagoLabel).filter(([k]) => k !== "CTA_CTE").map(([k, l]) => (<SelectItem key={k} value={k}>{l}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-[11px] text-warning mt-2">Necesitás la caja abierta: el pago sale de la caja.</p>
        </SectionCard>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={!effSuc || !monto || monto <= 0 || m.isPending}>Registrar pago</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetalleCliente({ cliente, onClose, onPagar }: any) {
  const { data: cu } = useCurrentUser();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  // Extracto: libro de movimientos del cliente. OJO: la RLS filtra por sucursal,
  // así que para un cajero NO-admin esta lista muestra solo SU sucursal (a
  // propósito: no filtra qué compró el cliente en otra sucursal).
  const { data: movs = [] } = useQuery({
    queryKey: ["ctacte-cliente", cliente.id],
    queryFn: async () => ((await supabase.from("cuenta_corriente_movimientos")
      .select("id, created_at, tipo, monto, estado, forma_pago, descripcion, venta_id, sucursal:sucursales(nombre)")
      .eq("cliente_id", cliente.id)
      .order("created_at", { ascending: false })).data ?? []) as any[],
  });

  // Resumen GLOBAL (todas las sucursales) vía RPC SECURITY DEFINER. NO se
  // recomputa desde `movs` (RLS-filtrado): un cajero vería un saldo parcial.
  const { data: resumen } = useQuery({
    queryKey: ["ctacte-resumen", cliente.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("cc_resumen", { _cliente_id: cliente.id });
      if (error) throw error;
      return ((Array.isArray(data) ? data[0] : data) ?? {}) as { total_debe: number; total_pagado: number; saldo: number };
    },
  });
  const totalDebe = Number(resumen?.total_debe ?? 0);
  const totalPagado = Number(resumen?.total_pagado ?? 0);
  const saldo = Number(resumen?.saldo ?? 0);

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{cliente.razon_social}</span>
            <Button size="sm" onClick={onPagar}><Wallet className="h-4 w-4 mr-1" /> Registrar pago</Button>
          </DialogTitle>
        </DialogHeader>
        <SectionCard title="Resumen de la cuenta">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Debe</div>
              <div className="font-mono font-bold text-lg">{fmtMoney(totalDebe)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pagado</div>
              <div className="font-mono font-bold text-lg text-success">{fmtMoney(totalPagado)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Saldo</div>
              <div className={`font-mono font-bold text-lg ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : ""}`}>
                {fmtMoney(saldo)}{saldo < -0.01 && " a favor"}
              </div>
            </div>
          </div>
        </SectionCard>

        {cu && !cu.isAdmin && (
          <p className="text-[11px] text-muted-foreground">
            El saldo es el total del cliente en todas las sucursales. La lista muestra solo los movimientos de tu sucursal.
          </p>
        )}
        <h4 className="font-semibold">Movimientos de la cuenta</h4>
        <DataTable
          columns={["Fecha", "Detalle", "Sucursal", "Debe", "Haber"]}
          isEmpty={movs.length === 0}
          empty={{ text: "Sin movimientos" }}
        >
          {movs.map((m: any) => {
            const anulado = m.estado === "ANULADO";
            const tieneVenta = m.tipo === "DEBITO" && !!m.venta_id;
            const abierto = expanded.has(m.id);
            return (
              <Fragment key={m.id}>
                <TableRow className={anulado ? "opacity-40 line-through" : ""}>
                  <TableCell className="text-xs">{fmtDate(m.created_at)}</TableCell>
                  <TableCell className="text-sm">
                    {tieneVenta ? (
                      <button className="inline-flex items-center gap-1 hover:text-primary" onClick={() => toggle(m.id)}>
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${abierto ? "rotate-90" : ""}`} />
                        {m.descripcion}
                      </button>
                    ) : m.descripcion}
                    {m.forma_pago && <span className="text-xs text-muted-foreground"> · {formaPagoLabel[m.forma_pago] ?? m.forma_pago}</span>}
                    {anulado && <span className="ml-2"><StatusPill tone="neutral">anulado</StatusPill></span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{m.sucursal?.nombre}</TableCell>
                  <TableCell className="text-right font-mono">{m.tipo === "DEBITO" ? fmtMoney(m.monto) : "—"}</TableCell>
                  <TableCell className="text-right font-mono text-success">{m.tipo === "CREDITO" ? fmtMoney(m.monto) : "—"}</TableCell>
                </TableRow>
                {tieneVenta && abierto && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/40 p-0">
                      <ItemsVenta ventaId={m.venta_id} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </DataTable>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cerrar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ItemsVenta({ ventaId }: { ventaId: string }) {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["venta-items", ventaId],
    queryFn: async () => ((await supabase.from("venta_items")
      .select("descripcion, cantidad, precio_unitario_sin_iva, subtotal_con_iva")
      .eq("venta_id", ventaId)).data ?? []) as any[],
  });
  if (isLoading) return <div className="px-4 py-2 text-xs text-muted-foreground">Cargando productos…</div>;
  if (items.length === 0) return <div className="px-4 py-2 text-xs text-muted-foreground">Sin productos.</div>;
  return (
    <div className="px-4 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Productos que llevó</div>
      <ul className="space-y-0.5 text-xs">
        {items.map((it: any, i: number) => (
          <li key={i} className="flex justify-between gap-3">
            <span className="truncate"><span className="font-mono">{it.cantidad}×</span> {it.descripcion}</span>
            <span className="font-mono text-muted-foreground shrink-0">{fmtMoney(it.subtotal_con_iva)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PagoDialog({ open, onClose, cliente, onSaved }: any) {
  const { data: cu } = useCurrentUser();
  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const [sucId, setSucId] = useState<string>("");
  const [monto, setMonto] = useState<number | null>(null);
  const [forma, setForma] = useState<string>("EFECTIVO");
  const [detalle, setDetalle] = useState<Record<string, any>>({});
  const [obs, setObs] = useState("");
  const cobrarFn = useServerFn(registrarCobranza);

  const effSuc = sucId || cu?.sucursal?.id || "";
  const m = useMutation({
    mutationFn: async () => cobrarFn({
      data: {
        cliente_id: cliente.id, sucursal_id: effSuc,
        monto: Number(monto || 0), forma_pago: forma as any,
        detalle, observaciones: obs || null,
      },
    }),
    onSuccess: (r: any) => {
      const saldo = Number(r?.saldo ?? 0);
      toast.success(
        saldo < -0.01
          ? `Cobro registrado. Queda ${fmtMoney(Math.abs(saldo))} a favor del cliente.`
          : `Cobro registrado. Saldo: ${fmtMoney(saldo)}.`,
      );
      onSaved(); setMonto(null); setObs(""); setDetalle({});
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Registrar cobro · {cliente.razon_social}</DialogTitle></DialogHeader>
        <SectionCard title="Datos del cobro">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cu?.isAdmin && (
            <div className="col-span-2"><Label>Sucursal (caja donde entra)</Label>
              <Select value={sucId} onValueChange={setSucId}>
                <SelectTrigger><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                <SelectContent>{sucs.map((s: any) => (<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
              </Select>
            </div>
          )}
          <div><Label>Monto *</Label><NumberInput value={monto} onValueChange={setMonto} /></div>
          <div><Label>Forma de pago *</Label>
            <Select value={forma} onValueChange={setForma}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(formaPagoLabel).filter(([k]) => k !== "CTA_CTE").map(([k, l]) => (<SelectItem key={k} value={k}>{l}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          {forma === "CHEQUE" && (<>
            <div><Label>Banco</Label><Input value={detalle.banco ?? ""} onChange={(e) => setDetalle(d => ({ ...d, banco: e.target.value }))} /></div>
            <div><Label>Nro cheque</Label><Input value={detalle.numero ?? ""} onChange={(e) => setDetalle(d => ({ ...d, numero: e.target.value }))} /></div>
            <div><Label>Firmante</Label><Input value={detalle.firmante ?? ""} onChange={(e) => setDetalle(d => ({ ...d, firmante: e.target.value }))} /></div>
            <div><Label>Fecha cobro</Label><Input type="date" value={detalle.fecha_cobro ?? ""} onChange={(e) => setDetalle(d => ({ ...d, fecha_cobro: e.target.value }))} /></div>
          </>)}
          {forma === "TRANSFERENCIA" && (
            <div className="col-span-2"><Label>Banco / Cuenta</Label><Input value={detalle.banco ?? ""} onChange={(e) => setDetalle(d => ({ ...d, banco: e.target.value }))} /></div>
          )}
          <div className="col-span-2"><Label>Observaciones</Label>
            <Input value={obs} onChange={(e) => setObs(e.target.value)} />
          </div>
        </div>
        </SectionCard>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={!effSuc || !monto || monto <= 0 || m.isPending}>Registrar cobro</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
