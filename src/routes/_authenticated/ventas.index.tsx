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
import { VentaItemsDetalle } from "@/components/ventas/venta-items-detalle";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { fmtDocumento } from "@/lib/documento";
import { Plus, Eye, Ban, Printer, FileSpreadsheet, FileCheck2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { anularVenta } from "@/lib/ventas.functions";
import { sePuedeAnularVenta } from "@/lib/anulacion-venta";
import {
  emitirComprobante,
  datosFiscalesComprobante,
} from "@/lib/fiscal.functions";
import { obtenerConfigFiscal } from "@/lib/fiscal/config.functions";
import { esComprobanteFiscal, esNotaInterna } from "@/lib/fiscal/codigos";
import { diasRestantesVentanaAfip, fueraDeVentanaAfip, VENTANA_AFIP_DIAS } from "@/lib/fiscal/fecha";
import { generarComprobantePdf } from "@/lib/fiscal/comprobante-pdf";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/ventas/")({
  component: VentasList,
});

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

  const { data: ventasResult, isLoading: loadingVentas, error: ventasError } = useQuery({
    queryKey: ["ventas", cu?.user.id, sucFilter, pagoFilter],
    enabled: !!cu,
    queryFn: async () => {
      // Los pagos sólo hacen falta al exportar. Incluirlos acá obliga a PostgREST
      // a resolver la relación y su RLS para cada una de las 200 ventas; si esa
      // consulta falla, antes se convertía el error en "0 comprobantes".
      const cargar = async (conRelaciones: boolean) => {
        let consulta = supabase.from("ventas")
          .select(conRelaciones
            ? "*, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,codigo,telefono)"
            : "*")
          .order("fecha", { ascending: false })
          .limit(200);
        if (sucFilter) consulta = consulta.eq("sucursal_id", sucFilter);
        if (pagoFilter !== "all") consulta = consulta.eq("estado_pago", pagoFilter as any);
        return consulta;
      };

      const principal = await cargar(true);
      if (!principal.error && principal.data?.length) {
        return { filas: principal.data as any[], aviso: null as string | null };
      }

      // La consulta simple conserva el listado aunque falle una relación.
      const simple = await cargar(false);
      if (simple.error) throw new Error(simple.error.message);
      const filas = (simple.data ?? []) as any[];
      return {
        filas,
        aviso: filas.length > 0
          ? `No se pudieron cargar los datos relacionados: ${principal.error?.message ?? "consulta incompleta"}`
          : null,
      };
    },
  });
  const ventas = ventasResult?.filas ?? [];

  const filtered = useMemo(() => ventas.filter((v:any) =>
    !q || `${v.numero_comprobante} ${v.cliente?.razon_social ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [ventas, q]);

  /**
   * Cuáles de las notas sin CAE real en pantalla las generó una ANULACIÓN.
   *
   * Esas no se pueden anular (ver sePuedeAnular). Va en una consulta aparte y no
   * en un embed de la principal porque PostgREST no resuelve la auto-referencia
   * de `ventas.venta_anulada_por` por nombre de constraint: devuelve PGRST200 y
   * se cae la pantalla entera. Acá se pregunta al revés y sólo por los ids
   * candidatos, así que es una consulta chica y sólo cuando hace falta.
   */
  const idsNotasSinCaeReal = useMemo(
    () =>
      ventas
        .filter(
          (v: any) => v.tipo_comprobante === "NOTA_CREDITO" && (!v.cae || v.afip_simulado),
        )
        .map((v: any) => v.id as string),
    [ventas],
  );
  const { data: generadasPorAnulacion = new Set<string>(), isSuccess: anulacionesConsultadas } = useQuery({
    queryKey: ["nc-de-anulacion", idsNotasSinCaeReal],
    enabled: idsNotasSinCaeReal.length > 0,
    queryFn: async () => {
      // De a 50. Un `.in()` con los 200 ids de la página son ~7,4 KB sólo de
      // UUIDs en la URL, y hay proxies que cortan la request line en 8 KB: el
      // día que la lista se llene de notas internas volvería a romperse
      // /ventas, que es justo lo que pasó con el embed que había acá antes.
      const encontradas = new Set<string>();
      for (let i = 0; i < idsNotasSinCaeReal.length; i += 50) {
        const { data } = await supabase
          .from("ventas")
          .select("venta_anulada_por")
          .in("venta_anulada_por", idsNotasSinCaeReal.slice(i, i + 50));
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
        toast.success(anulada?.tipo_comprobante === "NOTA_CREDITO" ? "Nota de crédito anulada" : "Venta anulada");
      }
      qc.invalidateQueries({ queryKey: ["ventas"] });
      setAnularDlg(null);
    },
    onError: (e:any) => toast.error(e.message),
  });

  // Sólo interesa el flag de modo simulado, para no avisar de un plazo que en
  // mock no se aplica. La respuesta pública no contiene claves ni certificados.
  const cargarCfg = useServerFn(obtenerConfigFiscal);
  const { data: cfgFiscal } = useQuery({
    queryKey: ["fiscal-config-multiemisor"],
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

  const exportar = async () => {
    const pagosPorVenta = new Map<string, any[]>();
    const ids = filtered.map((v: any) => v.id as string);
    for (let i = 0; i < ids.length; i += 50) {
      const { data, error } = await supabase
        .from("venta_pagos")
        .select("venta_id, forma_pago")
        .in("venta_id", ids.slice(i, i + 50));
      if (error) {
        toast.error(`No se pudo exportar la forma de pago: ${error.message}`);
        return;
      }
      for (const pago of data ?? []) {
        const existentes = pagosPorVenta.get(pago.venta_id) ?? [];
        existentes.push(pago);
        pagosPorVenta.set(pago.venta_id, existentes);
      }
    }
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((v: any) => ({
        Comprobante: v.numero_comprobante,
        Tipo: tipoComprobanteLabel[v.tipo_comprobante],
        Fecha: v.fecha,
        Sucursal: v.sucursal?.nombre,
        Cliente: v.cliente?.razon_social,
        "Total final": v.total,
        Pagado: v.total_pagado,
        Estado: v.estado_pago,
        // R12.b: forma(s) de pago. Cta cte no tiene venta_pagos (se cobra por cobranzas).
        "Forma de pago": pagosPorVenta.get(v.id)?.length
          ? pagosPorVenta.get(v.id)!
              .map((p: any) => formaPagoLabel[p.forma_pago] ?? p.forma_pago)
              .join(", ")
          : v.condicion_venta === "CTA_CTE"
            ? "Cuenta Corriente"
            : "—",
      })),
    );
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

      {(ventasError || ventasResult?.aviso) && (
        <SectionCard>
          <p className="text-sm text-destructive">
            {ventasError
              ? `No se pudieron cargar los comprobantes: ${ventasError.message}`
              : ventasResult?.aviso}
          </p>
        </SectionCard>
      )}

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
        empty={{ text: ventasError ? "No se pudieron cargar los comprobantes." : "No hay comprobantes para este filtro.", icon: <FileSpreadsheet className="h-7 w-7" /> }}
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
              {v.estado === "ACTIVA" &&
                (v.tipo_comprobante !== "NOTA_CREDITO" || anulacionesConsultadas) &&
                sePuedeAnularVenta(v, generadasPorAnulacion) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title={v.tipo_comprobante === "NOTA_CREDITO" ? "Anular nota de crédito" : "Anular venta"}
                    aria-label={v.tipo_comprobante === "NOTA_CREDITO" ? "Anular nota de crédito" : "Anular venta"}
                    onClick={() => setAnularDlg(v)}
                  >
                    <Ban className="h-3.5 w-3.5 text-destructive" />
                  </Button>
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
          {/* Anular una nota sin CAE real NO genera otra nota: la revierte. Decir lo
              contrario haría buscar en el listado un comprobante que no existe. */}
          {anularDlg?.tipo_comprobante === "NOTA_CREDITO" ? (
            <p className="text-sm">
              ¿Confirmás anular <strong>{anularDlg?.numero_comprobante}</strong>? Se va a revertir
              todo lo que hizo: sale de nuevo el stock que había devuelto y{" "}
              {anularDlg?.condicion_venta === "CTA_CTE"
                ? "se elimina el crédito de la cuenta corriente del cliente. No se mueve la caja."
                : "la plata devuelta vuelve a la caja de hoy."} No se genera ningún comprobante nuevo.
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
              <VentaItemsDetalle
                tipoComprobante={venta.tipo_comprobante}
                items={detail?.items ?? []}
              />
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
                  {Number(venta.percepciones) > 0 && (
                    <li className="flex justify-between">
                      <span>Percepciones:</span>
                      <span className="font-mono">{fmtMoney(venta.percepciones)}</span>
                    </li>
                  )}
                  <li className="flex justify-between font-bold">
                    <span>TOTAL:</span>
                    <span className="font-mono">{fmtMoney(venta.total)}</span>
                  </li>
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
