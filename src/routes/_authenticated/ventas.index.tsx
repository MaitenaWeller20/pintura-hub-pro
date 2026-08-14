import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { SectionCard } from "@/components/app/section-card";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { fmtDocumento } from "@/lib/documento";
import { Plus, Eye, Ban, Printer, FileSpreadsheet, FileCheck2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { anularVenta } from "@/lib/ventas.functions";
import {
  emitirComprobante,
  datosFiscalesComprobante,
  obtenerConfigFiscal,
} from "@/lib/fiscal.functions";
import { esComprobanteFiscal, esNotaInterna } from "@/lib/fiscal/codigos";
import { diasRestantesVentanaAfip, fueraDeVentanaAfip, VENTANA_AFIP_DIAS } from "@/lib/fiscal/fecha";
import { generarComprobantePdf } from "@/lib/fiscal/comprobante-pdf";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/ventas/")({
  component: VentasList,
});

/** Los comprobantes que `anular_venta` acepta. */
const ANULABLES = [
  "FACTURA_A",
  "FACTURA_B",
  "FACTURA_C",
  "REMITO",
  "REMITO_OBRA",
  "FAC_INTERNA_CTA_CTE",
];

/**
 * Las notas FISCALES no se anulan: se corrigen con otra nota.
 *
 * La excepción es la nota de crédito INTERNA cargada A MANO —sin CAE y sin
 * factura asociada—, que nunca se declaró a AFIP: no hay nada que rectificar con
 * un documento compensatorio, así que se revierte y listo. Sin esto, una nota
 * cargada por error quedaba para siempre, con el stock ya repuesto y el crédito
 * ya dado, y el único arreglo era SQL a mano contra producción.
 *
 * Quedan afuera las notas internas que generó una ANULACIÓN: esas no son un
 * documento aparte sino la mitad de una anulación que ya devolvió el stock y ya
 * resolvió la plata. Revertirlas descuadraría las dos cosas. Cuáles son las
 * averigua `generadasPorAnulacion` (ver más abajo). El mismo criterio está en
 * `anular_venta`, que es donde manda de verdad: esto sólo evita ofrecer un botón
 * que va a fallar.
 */
function sePuedeAnular(v: any, generadasPorAnulacion: Set<string>): boolean {
  if (ANULABLES.includes(v.tipo_comprobante)) return true;
  return (
    v.tipo_comprobante === "NOTA_CREDITO" &&
    !v.cae &&
    esNotaInterna(v.tipo_comprobante, v.afip_cbte_asoc_id) &&
    !generadasPorAnulacion.has(v.id)
  );
}

function VentasList() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucFilter, setSucFilter] = useState("");
  const [pagoFilter, setPagoFilter] = useState("all");
  const [q, setQ] = useState("");
  const [verVenta, setVerVenta] = useState<any>(null);
  const [anularDlg, setAnularDlg] = useState<any>(null);
  const anularFn = useServerFn(anularVenta);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });

  const { data: ventas = [], isLoading: loadingVentas } = useQuery({
    queryKey: ["ventas", cu?.user.id, sucFilter, pagoFilter],
    enabled: !!cu,
    queryFn: async () => {
      let q = supabase.from("ventas").select(`
        *, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,codigo,telefono),
        pagos:venta_pagos(forma_pago,monto)
      `).order("fecha", { ascending: false }).limit(200);
      if (sucFilter) q = q.eq("sucursal_id", sucFilter);
      if (pagoFilter !== "all") q = q.eq("estado_pago", pagoFilter as any);
      return (((await q).data) ?? []) as any[];
    },
  });

  const filtered = useMemo(() => ventas.filter((v:any) =>
    !q || `${v.numero_comprobante} ${v.cliente?.razon_social ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [ventas, q]);

  /**
   * Cuáles de las notas internas en pantalla las generó una ANULACIÓN.
   *
   * Esas no se pueden anular (ver sePuedeAnular). Va en una consulta aparte y no
   * en un embed de la principal porque PostgREST no resuelve la auto-referencia
   * de `ventas.venta_anulada_por` por nombre de constraint: devuelve PGRST200 y
   * se cae la pantalla entera. Acá se pregunta al revés y sólo por los ids
   * candidatos, así que es una consulta chica y sólo cuando hace falta.
   */
  const idsNotasInternas = useMemo(
    () =>
      ventas
        .filter(
          (v: any) => v.tipo_comprobante === "NOTA_CREDITO" && !v.cae && !v.afip_cbte_asoc_id,
        )
        .map((v: any) => v.id as string),
    [ventas],
  );
  const { data: generadasPorAnulacion = new Set<string>() } = useQuery({
    queryKey: ["nc-de-anulacion", idsNotasInternas],
    enabled: idsNotasInternas.length > 0,
    queryFn: async () => {
      // De a 50. Un `.in()` con los 200 ids de la página son ~7,4 KB sólo de
      // UUIDs en la URL, y hay proxies que cortan la request line en 8 KB: el
      // día que la lista se llene de notas internas volvería a romperse
      // /ventas, que es justo lo que pasó con el embed que había acá antes.
      const encontradas = new Set<string>();
      for (let i = 0; i < idsNotasInternas.length; i += 50) {
        const { data } = await supabase
          .from("ventas")
          .select("venta_anulada_por")
          .in("venta_anulada_por", idsNotasInternas.slice(i, i + 50));
        for (const r of data ?? []) encontradas.add((r as any).venta_anulada_por as string);
      }
      return encontradas;
    },
  });

  const anular = useMutation({
    mutationFn: async (id: string) => anularFn({ data: { venta_id: id } }),
    onSuccess: (_r, id) => {
      // Si el comprobante estaba declarado, la anulación todavía no terminó: falta
      // emitirle la NC a AFIP. Que el toast lo diga, no un "listo" que engañe.
      const anulada = ventas.find((v: any) => v.id === id);
      if (anulada?.cae && !anulada?.afip_simulado) {
        toast.warning("Venta anulada. Falta emitir la nota de crédito en AFIP.", { duration: 10000 });
      } else {
        toast.success("Venta anulada");
      }
      qc.invalidateQueries({ queryKey: ["ventas"] });
      setAnularDlg(null);
    },
    onError: (e:any) => toast.error(e.message),
  });

  // Sólo interesa el flag de modo simulado, para no avisar de un plazo que en
  // mock no se aplica. Se cachea con la misma clave que usa la pantalla de
  // Facturación, así que no agrega un ida y vuelta si ya se visitó.
  const cargarCfg = useServerFn(obtenerConfigFiscal);
  const { data: cfgFiscal } = useQuery({
    queryKey: ["fiscal-config"],
    queryFn: () => cargarCfg(),
    staleTime: 5 * 60_000,
  });
  const mockMode = cfgFiscal?.mock_mode ?? true;

  const emitirFn = useServerFn(emitirComprobante);
  const emitir = useMutation({
    mutationFn: async (id: string) => emitirFn({ data: { venta_id: id } }),
    onSuccess: (r: any) => {
      toast.success(
        r.recuperado
          ? `AFIP ya lo había autorizado. CAE ${r.cae} recuperado.`
          : `CAE ${r.cae} obtenido${r.modo === "HOMOLOGACION" ? " (homologación)" : ""}.`,
      );
      qc.invalidateQueries({ queryKey: ["ventas"] });
    },
    // Los errores de AFIP son largos y hay que poder leerlos.
    onError: (e: any) => toast.error(e.message, { duration: 12000 }),
  });

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(filtered.map((v:any) => ({
      Comprobante: v.numero_comprobante, Tipo: tipoComprobanteLabel[v.tipo_comprobante],
      Fecha: v.fecha, Sucursal: v.sucursal?.nombre, Cliente: v.cliente?.razon_social,
      Subtotal: v.subtotal_sin_iva, IVA: v.iva_total, Total: v.total, Pagado: v.total_pagado, Estado: v.estado_pago,
      // R12.b: forma(s) de pago. Cta cte no tiene venta_pagos (se cobra por cobranzas).
      "Forma de pago": (v.pagos?.length
        ? v.pagos.map((p:any) => formaPagoLabel[p.forma_pago] ?? p.forma_pago).join(", ")
        : (v.condicion_venta === "CTA_CTE" ? "Cuenta Corriente" : "—")),
    })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ventas");
    XLSX.writeFile(wb, "ventas.xlsx");
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ventas"
        subtitle={`${filtered.length} comprobantes`}
        actions={
          <>
            <Button variant="outline" onClick={exportar}><FileSpreadsheet className="h-4 w-4 mr-1"/> Excel</Button>
            <Button asChild><Link to="/ventas/nueva"><Plus className="h-4 w-4 mr-1"/> Nueva venta</Link></Button>
          </>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Buscar comprobante o cliente…" value={q} onChange={(e)=>setQ(e.target.value)} className="max-w-xs"/>
          {cu?.isAdmin && (
            <Select value={sucFilter || "__all__"} onValueChange={(v)=>setSucFilter(v==="__all__"?"":v)}>
              <SelectTrigger className="w-44"><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las sucursales</SelectItem>
                {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
              </SelectContent>
            </Select>
          )}
          <Select value={pagoFilter} onValueChange={setPagoFilter}>
            <SelectTrigger className="w-44"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              <SelectItem value="PAGADO">Pagado</SelectItem>
              <SelectItem value="PARCIAL">Pago parcial</SelectItem>
              <SelectItem value="PENDIENTE">Pendiente</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SectionCard>

      <DataTable
        columns={cu?.isAdmin
          ? ["Comprobante", "Tipo", "Fecha", "Cliente", "Sucursal", "Total", "Estado", "AFIP", ""]
          : ["Comprobante", "Tipo", "Fecha", "Cliente", "Total", "Estado", "AFIP", ""]}
        loading={loadingVentas}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay comprobantes para este filtro.", icon: <FileSpreadsheet className="h-7 w-7" /> }}
      >
        {filtered.map((v:any) => (
          <TableRow key={v.id} className={v.estado === "ANULADA" ? "opacity-50" : ""}>
            <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
            <TableCell>{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
            <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
            <TableCell>{v.cliente?.razon_social}</TableCell>
            {cu?.isAdmin && <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>}
            <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
            <TableCell>
              {v.estado === "ANULADA" ? <StatusPill tone="danger">ANULADA</StatusPill>
                : v.tipo_comprobante === "NOTA_CREDITO" ? <StatusPill tone="neutral">N. Crédito</StatusPill>
                : v.condicion_venta === "CTA_CTE" ? <StatusPill tone="info">Cta Cte</StatusPill>
                : (
                <StatusPill tone={v.estado_pago === "PAGADO" ? "success" : "warning"}>
                  {v.estado_pago}
                </StatusPill>
              )}
            </TableCell>
            <TableCell><EstadoAfip venta={v} mock={mockMode} /></TableCell>
            <TableCell>
              <Button size="sm" variant="ghost" onClick={()=>setVerVenta(v)}><Eye className="h-3.5 w-3.5"/></Button>
              {/* Sólo se factura lo que es un comprobante fiscal. Los remitos, la
                  factura interna y las notas que revierten algo nunca declarado
                  son documentos internos: no van a AFIP. */}
              {v.estado === "ACTIVA" && esComprobanteFiscal(v.tipo_comprobante)
                && !esNotaInterna(v.tipo_comprobante, v.afip_cbte_asoc_id) && !v.cae && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Emitir en AFIP"
                  onClick={() => emitir.mutate(v.id)}
                  disabled={emitir.isPending}
                >
                  {emitir.isPending && emitir.variables === v.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <FileCheck2 className="h-3.5 w-3.5 text-primary" />}
                </Button>
              )}
              {v.estado === "ACTIVA" && sePuedeAnular(v, generadasPorAnulacion) && (
                <Button size="sm" variant="ghost" onClick={()=>setAnularDlg(v)}><Ban className="h-3.5 w-3.5 text-destructive"/></Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      <DetalleVenta venta={verVenta} onClose={()=>setVerVenta(null)}/>

      <Dialog open={!!anularDlg} onOpenChange={(v)=>!v && setAnularDlg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Anular {anularDlg?.tipo_comprobante === "NOTA_CREDITO" ? "nota de crédito" : "venta"}
            </DialogTitle>
          </DialogHeader>
          {/* Anular una nota interna NO genera otra nota: la revierte. Decir lo
              contrario haría buscar en el listado un comprobante que no existe. */}
          {anularDlg?.tipo_comprobante === "NOTA_CREDITO" ? (
            <p className="text-sm">
              ¿Confirmás anular <strong>{anularDlg?.numero_comprobante}</strong>? Se va a revertir
              todo lo que hizo: sale de nuevo el stock que había devuelto, se le saca el crédito al
              cliente y la plata devuelta vuelve a la caja de hoy. No se genera ningún comprobante
              nuevo.
            </p>
          ) : (
            <p className="text-sm">¿Confirmás anular <strong>{anularDlg?.numero_comprobante}</strong>? Se generará una nota de crédito y se devolverá el stock automáticamente.</p>
          )}
          {/* Si el comprobante ya se declaró, anularlo acá NO lo anula ante AFIP:
              eso lo hace la nota de crédito, que es un segundo paso y hay que
              emitirla. Mientras tanto AFIP sigue teniendo la factura como válida. */}
          {anularDlg?.cae && !anularDlg?.afip_simulado && (
            <div className="flex items-start gap-2 p-3 rounded border border-warning/40 bg-warning/5 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div>
                Esta factura ya tiene CAE. Para AFIP sigue siendo válida hasta que{" "}
                <strong>emitas la nota de crédito</strong>, que te va a quedar en el listado
                como pendiente. Acordate de hacerlo: AFIP sólo la acepta dentro de los{" "}
                {VENTANA_AFIP_DIAS} días.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={()=>setAnularDlg(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={()=>anular.mutate(anularDlg.id)} disabled={anular.isPending}>Anular</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Estado fiscal del comprobante: si tiene CAE, si falló, o si ni siquiera aplica. */
function EstadoAfip({ venta, mock }: { venta: any; mock: boolean }) {
  if (
    !esComprobanteFiscal(venta.tipo_comprobante) ||
    esNotaInterna(venta.tipo_comprobante, venta.afip_cbte_asoc_id)
  ) {
    return (
      <span title="Documento interno: no se declara a AFIP">
        <StatusPill tone="info">Interno</StatusPill>
      </span>
    );
  }
  if (venta.cae) {
    // Un CAE simulado se parece a uno real (14 dígitos) pero no vale nada. Que se
    // note a simple vista: si no, en el listado conviven mezclados y no hay forma
    // de saber cuáles se declararon de verdad.
    if (venta.afip_simulado) {
      return (
        <div className="text-xs space-y-0.5" title="CAE generado en modo simulado: no se declaró a AFIP y no tiene validez legal.">
          <StatusPill tone="warning"><span className="font-mono">{venta.cae}</span></StatusPill>
          <div className="text-muted-foreground">simulado — sin validez</div>
        </div>
      );
    }
    return (
      <div className="text-xs space-y-0.5">
        <StatusPill tone="success"><span className="font-mono">{venta.cae}</span></StatusPill>
        <div className="text-muted-foreground">
          {venta.afip_modo === "HOMOLOGACION" ? "homologación" : `PV ${venta.afip_punto_venta}-${venta.afip_numero}`}
        </div>
      </div>
    );
  }
  if (venta.afip_estado === "ERROR") {
    return (
      <span title={venta.afip_error ?? ""}>
        <StatusPill tone="danger" icon={<AlertTriangle className="h-2.5 w-2.5" />}>ERROR</StatusPill>
      </span>
    );
  }
  if (venta.afip_estado === "PENDIENTE") {
    return <StatusPill tone="warning">PENDIENTE</StatusPill>;
  }

  // Sin emitir. Lo que importa acá no es el estado, es el reloj: AFIP deja de
  // aceptar la fecha del comprobante a los 5 días y después ya no hay forma de
  // facturarlo. Se avisa antes de que sea tarde.
  //
  // En modo simulado no se avisa nada: ahí no hay AFIP que rechace, el servidor
  // tampoco aplica la ventana, y un cartel de "fuera de plazo" sobre un botón que
  // igual funciona confunde más de lo que ayuda.
  if (mock) return <StatusPill tone="neutral">Sin emitir</StatusPill>;

  const restantes = diasRestantesVentanaAfip(new Date(venta.fecha));
  // Fuera de ventana por los DOS lados: una venta fechada a futuro más allá del
  // límite también la rechaza AFIP, y ahí `restantes` da un número grande que
  // haría parecer que sobra tiempo.
  if (fueraDeVentanaAfip(new Date(venta.fecha))) {
    const futura = restantes > VENTANA_AFIP_DIAS;
    return (
      <span
        title={
          futura
            ? `La venta está fechada a futuro y AFIP sólo autoriza hasta ${VENTANA_AFIP_DIAS} días adelante. Revisá la fecha.`
            : `AFIP no autoriza comprobantes fechados a más de ${VENTANA_AFIP_DIAS} días. Consultá con el contador cómo regularizarla.`
        }
      >
        <StatusPill tone="danger" icon={<AlertTriangle className="h-2.5 w-2.5" />}>
          {futura ? "Fecha futura" : "Fuera de plazo"}
        </StatusPill>
      </span>
    );
  }
  if (restantes <= 2) {
    return (
      <span title={`AFIP deja de aceptar esta fecha en ${restantes} día(s). Emitila ya.`}>
        <StatusPill tone="warning">{restantes === 0 ? "Último día" : `Quedan ${restantes} días`}</StatusPill>
      </span>
    );
  }
  return <StatusPill tone="neutral">Sin emitir</StatusPill>;
}

function DetalleVenta({ venta, onClose }: { venta: any; onClose: () => void }) {
  const { data: detail } = useQuery({
    queryKey: ["venta-detail", venta?.id],
    enabled: !!venta,
    queryFn: async () => {
      const [{ data: items = [] }, { data: pagos = [] }] = await Promise.all([
        supabase.from("venta_items").select("*").eq("venta_id", venta.id),
        supabase.from("venta_pagos").select("*").eq("venta_id", venta.id),
      ]);
      return { items: (items ?? []) as any[], pagos: (pagos ?? []) as any[] };
    },
  });
  const datosFiscalesFn = useServerFn(datosFiscalesComprobante);

  const imprimir = async () => {
    if (!venta) return;

    // Los datos fiscales (CAE, QR, y el emisor/receptor CONGELADOS al emitir) sólo
    // existen si el comprobante está autorizado. Sin ellos se imprime la misma
    // hoja pero marcada como documento interno.
    let fiscal: any = null;
    if (venta.cae && esComprobanteFiscal(venta.tipo_comprobante)) {
      try {
        fiscal = await datosFiscalesFn({ data: { venta_id: venta.id } });
      } catch {
        fiscal = null;
      }
    }

    const { doc, nombre } = generarComprobantePdf(venta, detail?.items ?? [], fiscal);
    doc.save(nombre);
  };

  return (
    <Dialog open={!!venta} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        {venta && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center justify-between">
                <span>{tipoComprobanteLabel[venta.tipo_comprobante]} · {venta.numero_comprobante}</span>
                <Button size="sm" variant="outline" onClick={imprimir}><Printer className="h-4 w-4 mr-1"/> PDF</Button>
              </DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div><strong>Fecha:</strong> {fmtDateTime(venta.fecha)}</div>
              <div><strong>Sucursal:</strong> {venta.sucursal?.nombre}</div>
              <div><strong>Cliente:</strong> {venta.cliente?.razon_social}</div>
              <div><strong>CUIT/DNI:</strong> {fmtDocumento(venta.cliente?.cuit_dni)}</div>
            </div>
            <div className="mt-2">
              <DataTable columns={["Cód.", "Descripción", "Cant.", "P. unit.", "Subtotal"]}>
                {(detail?.items ?? []).map((i:any,idx)=>(
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-xs">{i.codigo}</TableCell>
                    <TableCell>{i.descripcion}</TableCell>
                    <TableCell className="text-right">{i.cantidad}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(i.precio_unitario_sin_iva)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(i.subtotal_con_iva)}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <Card className="p-3">
                <h4 className="font-semibold text-sm mb-2">Pagos</h4>
                {venta.condicion_venta === "CTA_CTE" ? (
                  <p className="text-xs text-muted-foreground">
                    Venta a cuenta corriente. Los cobros de esta venta se registran y se ven en{" "}
                    <Link to="/cuentas-corrientes" className="text-primary underline">Cuentas Corrientes</Link>.
                  </p>
                ) : (detail?.pagos ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Sin pagos registrados.</p> :
                  <ul className="space-y-1 text-sm">
                    {detail!.pagos.map((p:any,i)=>(
                      <li key={i} className="flex justify-between">
                        <span>{formaPagoLabel[p.forma_pago]}{p.detalle && Object.keys(p.detalle).length ? ` (${Object.values(p.detalle).join(", ")})` : ""}</span>
                        <span className="font-mono">{fmtMoney(p.monto)}</span>
                      </li>
                    ))}
                  </ul>}
              </Card>
              <Card className="p-3">
                <h4 className="font-semibold text-sm mb-2">Totales</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex justify-between"><span>Subtotal:</span><span className="font-mono">{fmtMoney(venta.subtotal_sin_iva)}</span></li>
                  <li className="flex justify-between"><span>IVA:</span><span className="font-mono">{fmtMoney(venta.iva_total)}</span></li>
                  <li className="flex justify-between"><span>Percepciones:</span><span className="font-mono">{fmtMoney(venta.percepciones)}</span></li>
                  <li className="flex justify-between font-bold border-t border-border pt-1 mt-1"><span>TOTAL:</span><span className="font-mono">{fmtMoney(venta.total)}</span></li>
                  {venta.condicion_venta === "CTA_CTE" ? (
                    <li className="flex justify-between text-warning"><span>Condición:</span><span>A cuenta corriente</span></li>
                  ) : (
                    <>
                      <li className="flex justify-between text-success"><span>Pagado:</span><span className="font-mono">{fmtMoney(venta.total_pagado)}</span></li>
                      {Number(venta.total) - Number(venta.total_pagado) > 0.01 && (
                        <li className="flex justify-between text-destructive"><span>Pendiente:</span><span className="font-mono">{fmtMoney(Number(venta.total)-Number(venta.total_pagado))}</span></li>
                      )}
                    </>
                  )}
                </ul>
              </Card>
            </div>
            {venta.observaciones && <p className="text-xs text-muted-foreground mt-2"><strong>Obs:</strong> {venta.observaciones}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
