import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableRow, TableCell } from "@/components/ui/table";
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
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { SectionCard } from "@/components/app/section-card";
import { EstadoFiscalPill } from "@/components/fiscal/estado-fiscal-pill";
import { ValidezFiscal } from "@/components/fiscal/validez-fiscal";
import { DialogoDetalleVenta, type VentaDetalle } from "@/components/ventas/dialogo-detalle-venta";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { Plus, Eye, Ban, FileSpreadsheet, FileCheck2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { anularVenta } from "@/lib/ventas.functions";
import { emitirComprobante } from "@/lib/fiscal.functions";
import { obtenerEstadoFiscalPublico } from "@/lib/fiscal/config.functions";
import { QUERY_KEY_ESTADO_FISCAL_PUBLICO } from "@/lib/fiscal/config";
import { esComprobanteFiscal, esNotaInterna } from "@/lib/fiscal/codigos";
import {
  diasRestantesVentanaAfip,
  fueraDeVentanaAfip,
  VENTANA_AFIP_DIAS,
} from "@/lib/fiscal/fecha";
import { CBTE_INFO } from "@/lib/fiscal/codigos";
import { numeroFiscal } from "@/lib/fiscal/comprobante-pdf";
import { mensajeErrorFiscal } from "@/lib/fiscal/error-usuario";
import {
  camposExportacionReceptorFiscal,
  describirCaeLegacy,
  leerReceptorFiscalCongelado,
  puedeOfrecerEmisionLegacy,
  receptorFiscalDifiereDelComprador,
  requiereAdvertenciaAnulacionProduccion,
  ventaCoincideBusqueda,
} from "@/lib/ventas-ui";
import {
  adquirirBloqueoAnulacion,
  crearIntentoAnulacion,
  liberarBloqueoAnulacion,
  solicitudAnulacion,
  type IntentoAnulacion,
} from "@/lib/anulacion-venta-ui";
import { COLUMNAS_VENTA_SEGURAS } from "@/lib/ventas-proyeccion";
import { esVentaVisibleEnListadoComercial } from "@/lib/nota-credito-periodo-ui";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/ventas/")({
  component: VentasList,
});

/** Los comprobantes que `anular_venta` acepta. */
const ANULABLES = [
  "VENTA",
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
  // La RPC sólo puede derivar una NC automática desde evidencia de producción.
  // Un CAE de prueba no se ofrece como anulable porque homologación/simulación
  // no pueden presentarse como comprobantes con validez legal.
  if (v.cae && !requiereAdvertenciaAnulacionProduccion(v)) return false;
  if (ANULABLES.includes(v.tipo_comprobante)) return true;
  return (
    v.tipo_comprobante === "NOTA_CREDITO" &&
    !v.cae &&
    esNotaInterna(
      v.tipo_comprobante,
      v.afip_cbte_asoc_id,
      v.periodo_asoc_desde,
      v.periodo_asoc_hasta,
    ) &&
    !generadasPorAnulacion.has(v.id)
  );
}

function comprobanteFiscalVisible(venta: {
  afip_cbte_tipo: number | null;
  afip_punto_venta: number | null;
  afip_numero: number | null;
}): string | null {
  if (!venta.afip_cbte_tipo || !venta.afip_punto_venta || !venta.afip_numero) return null;
  const info = CBTE_INFO[venta.afip_cbte_tipo];
  if (!info) return null;
  const tipo = [1, 6, 11].includes(venta.afip_cbte_tipo)
    ? "Factura"
    : [3, 8, 13].includes(venta.afip_cbte_tipo)
      ? "Nota de crédito"
      : "Comprobante";
  return `${tipo} ${info.letra} ${numeroFiscal(venta.afip_punto_venta, venta.afip_numero)}`;
}

function VentasList() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucFilter, setSucFilter] = useState("");
  const [pagoFilter, setPagoFilter] = useState("all");
  const [q, setQ] = useState("");
  const [verVenta, setVerVenta] = useState<VentaDetalle | null>(null);
  const [anularDlg, setAnularDlg] = useState<IntentoAnulacion<VentaDetalle> | null>(null);
  const anulandoRef = useRef(false);
  const [anulacionBloqueada, setAnulacionBloqueada] = useState(false);
  const anularFn = useServerFn(anularVenta);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });

  const { data: ventas = [], isLoading: loadingVentas } = useQuery({
    queryKey: ["ventas", cu?.user.id, sucFilter, pagoFilter],
    enabled: !!cu,
    queryFn: async () => {
      let q = supabase
        .from("ventas")
        .select(
          `
        ${COLUMNAS_VENTA_SEGURAS}, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,codigo,telefono),
        pagos:venta_pagos(forma_pago,monto)
      `,
        )
        .order("fecha", { ascending: false })
        .limit(200);
      if (sucFilter) q = q.eq("sucursal_id", sucFilter);
      if (pagoFilter !== "all") q = q.eq("estado_pago", pagoFilter as any);
      return ((await q).data ?? []) as any[];
    },
  });

  const filtered = useMemo(
    () =>
      ventas.filter(
        (v) => esVentaVisibleEnListadoComercial(v.estado) && ventaCoincideBusqueda(v, q),
      ),
    [ventas, q],
  );

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
          (v: any) =>
            !v.cae &&
            esNotaInterna(
              v.tipo_comprobante,
              v.afip_cbte_asoc_id,
              v.periodo_asoc_desde,
              v.periodo_asoc_hasta,
            ),
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
    mutationFn: async (intento: IntentoAnulacion<VentaDetalle>) =>
      anularFn({ data: solicitudAnulacion(intento) }),
    onSuccess: (_r, intento) => {
      // Si el comprobante estaba declarado, la anulación todavía no terminó: falta
      // emitirle la NC a AFIP. Que el toast lo diga, no un "listo" que engañe.
      const anulada = intento.venta;
      if (requiereAdvertenciaAnulacionProduccion(anulada)) {
        toast.warning("Venta anulada. Falta emitir la nota de crédito en AFIP.", {
          duration: 10000,
        });
      } else {
        toast.success("Venta anulada");
      }
      qc.invalidateQueries({ queryKey: ["ventas"] });
      qc.invalidateQueries({ queryKey: ["nc-de-anulacion"] });
      setAnularDlg(null);
    },
    onError: () => {
      // La RPC es idempotente. Si se perdió la respuesta después del commit,
      // conservar este diálogo conserva también la clave: el siguiente click
      // recupera la misma NC en vez de intentar crear otra.
      qc.invalidateQueries({ queryKey: ["ventas"] });
      qc.invalidateQueries({ queryKey: ["nc-de-anulacion"] });
      toast.error(
        "No se pudo confirmar la respuesta de la anulación. Reintentá desde este mismo diálogo para recuperar la operación; no abras otra anulación.",
        { duration: 12000 },
      );
    },
    onSettled: () => {
      liberarBloqueoAnulacion(anulandoRef);
      setAnulacionBloqueada(false);
    },
  });

  const confirmarAnulacion = () => {
    if (!anularDlg || !adquirirBloqueoAnulacion(anulandoRef)) return;
    setAnulacionBloqueada(true);
    anular.mutate(anularDlg);
  };

  const bloqueoAnulacion = anulacionBloqueada || anular.isPending;

  // Sólo interesa el flag de modo simulado, para no avisar de un plazo que en
  // mock no se aplica. La respuesta pública no contiene claves ni certificados.
  const cargarCfg = useServerFn(obtenerEstadoFiscalPublico);
  const { data: cfgFiscal } = useQuery({
    queryKey: QUERY_KEY_ESTADO_FISCAL_PUBLICO,
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
    onError: (error: unknown) =>
      toast.error(mensajeErrorFiscal(error, "EMISION"), { duration: 12000 }),
  });

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((v: any) => ({
        Comprobante: v.numero_comprobante,
        Tipo: tipoComprobanteLabel[v.tipo_comprobante],
        Fecha: v.fecha,
        Sucursal: v.sucursal?.nombre,
        Comprador: v.cliente?.razon_social,
        ...camposExportacionReceptorFiscal(v),
        Subtotal: v.subtotal_sin_iva,
        IVA: v.iva_total,
        Total: v.total,
        Pagado: v.total_pagado,
        Estado: v.estado_pago,
        // R12.b: forma(s) de pago. Cta cte no tiene venta_pagos (se cobra por cobranzas).
        "Forma de pago": v.pagos?.length
          ? v.pagos.map((p: any) => formaPagoLabel[p.forma_pago] ?? p.forma_pago).join(", ")
          : v.condicion_venta === "CTA_CTE"
            ? "Cuenta Corriente"
            : "—",
      })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ventas");
    XLSX.writeFile(wb, "ventas.xlsx");
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ventas"
        subtitle={`${filtered.length} comprobantes`}
        actions={
          <>
            <Button variant="outline" onClick={exportar}>
              <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
            </Button>
            <Button asChild>
              <Link to="/ventas/nueva">
                <Plus className="h-4 w-4 mr-1" /> Nueva venta
              </Link>
            </Button>
          </>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Buscar comprobante, comprador o receptor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          {cu?.isAdmin && (
            <Select
              value={sucFilter || "__all__"}
              onValueChange={(v) => setSucFilter(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las sucursales</SelectItem>
                {sucs.map((s: any) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={pagoFilter} onValueChange={setPagoFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
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
        columns={
          cu?.isAdmin
            ? [
                "Venta",
                "Comprobante fiscal",
                "Tipo",
                "Fecha",
                "Cliente",
                "Sucursal",
                "Total",
                "Estado",
                "Fiscal",
                "",
              ]
            : [
                "Venta",
                "Comprobante fiscal",
                "Tipo",
                "Fecha",
                "Cliente",
                "Total",
                "Estado",
                "Fiscal",
                "",
              ]
        }
        loading={loadingVentas}
        isEmpty={filtered.length === 0}
        empty={{
          text: "No hay comprobantes para este filtro.",
          icon: <FileSpreadsheet className="h-7 w-7" />,
        }}
      >
        {filtered.map((v: any) => (
          <TableRow key={v.id} className={v.estado === "ANULADA" ? "opacity-50" : ""}>
            <TableCell className="font-mono text-xs">Venta {v.numero_comprobante}</TableCell>
            <TableCell className="text-xs">
              {comprobanteFiscalVisible(v) ?? <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell>{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
            <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
            <TableCell>
              <p>{v.cliente?.razon_social}</p>
              {receptorFiscalDifiereDelComprador(v) ? (
                <p className="text-xs text-muted-foreground" data-testid={`receptor-${v.id}`}>
                  → {leerReceptorFiscalCongelado(v.afip_snapshot)?.razonSocial}
                </p>
              ) : null}
            </TableCell>
            {cu?.isAdmin && (
              <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>
            )}
            <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
            <TableCell>
              {v.estado === "ANULADA" ? (
                <StatusPill tone="danger">ANULADA</StatusPill>
              ) : v.tipo_comprobante === "NOTA_CREDITO" ? (
                <StatusPill tone="neutral">N. Crédito</StatusPill>
              ) : v.condicion_venta === "CTA_CTE" ? (
                <StatusPill tone="info">Cta Cte</StatusPill>
              ) : (
                <StatusPill tone={v.estado_pago === "PAGADO" ? "success" : "warning"}>
                  {v.estado_pago}
                </StatusPill>
              )}
            </TableCell>
            <TableCell>
              {cu?.facturacionV2Habilitada ? (
                <div className="space-y-1">
                  <EstadoFiscalPill estado={v.afip_estado} />
                  <div>
                    <ValidezFiscal validez={v.afip_validez} estado={v.afip_estado} compacta />
                  </div>
                </div>
              ) : (
                <EstadoAfip venta={v} mock={mockMode} />
              )}
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 min-w-11"
                aria-label={`Ver detalle de ${v.numero_comprobante}`}
                title="Ver detalle"
                onClick={() => setVerVenta(v)}
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              {/* Sólo se factura lo que es un comprobante fiscal. Los remitos, la
                  factura interna y las notas que revierten algo nunca declarado
                  son documentos internos: no van a AFIP. */}
              {v.estado === "ACTIVA" &&
                cu?.facturacionLegacyHabilitada &&
                puedeOfrecerEmisionLegacy({
                  puedeFacturar: cu.puedeFacturar,
                  isAdmin: cu.isAdmin,
                  fecha: v.fecha,
                }) &&
                ["FACTURA_A", "FACTURA_B", "FACTURA_C", "NOTA_CREDITO"].includes(
                  v.tipo_comprobante,
                ) &&
                !esNotaInterna(
                  v.tipo_comprobante,
                  v.afip_cbte_asoc_id,
                  v.periodo_asoc_desde,
                  v.periodo_asoc_hasta,
                ) &&
                !v.cae && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11 min-w-11"
                    aria-label={`Emitir ${v.numero_comprobante} en AFIP`}
                    title="Emitir en AFIP"
                    onClick={() => emitir.mutate(v.id)}
                    disabled={emitir.isPending}
                  >
                    {emitir.isPending && emitir.variables === v.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileCheck2 className="h-3.5 w-3.5 text-primary" />
                    )}
                  </Button>
                )}
              {v.estado === "ACTIVA" &&
              cu?.facturacionV2Habilitada &&
              cu?.puedeFacturar &&
              ["VENTA", "NOTA_CREDITO"].includes(v.tipo_comprobante) &&
              !esNotaInterna(
                v.tipo_comprobante,
                v.afip_cbte_asoc_id,
                v.periodo_asoc_desde,
                v.periodo_asoc_hasta,
              ) &&
              !v.cae ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 min-w-11"
                  aria-label={`Revisar y facturar ${v.numero_comprobante}`}
                  title="Revisar y facturar"
                  asChild
                >
                  <a href={`/facturacion/cola?venta=${encodeURIComponent(v.id)}`}>
                    <FileCheck2 className="h-3.5 w-3.5 text-primary" />
                  </a>
                </Button>
              ) : null}
              {v.estado === "ACTIVA" && sePuedeAnular(v, generadasPorAnulacion) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 min-w-11"
                  aria-label={`Anular ${v.numero_comprobante}`}
                  title="Anular"
                  onClick={() => setAnularDlg(crearIntentoAnulacion(v))}
                >
                  <Ban className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      <DialogoDetalleVenta venta={verVenta} onClose={() => setVerVenta(null)} />

      <Dialog
        open={!!anularDlg}
        onOpenChange={(open) => !open && !bloqueoAnulacion && setAnularDlg(null)}
      >
        <DialogContent closeDisabled={bloqueoAnulacion} aria-busy={bloqueoAnulacion}>
          <DialogHeader>
            <DialogTitle>
              Anular{" "}
              {anularDlg?.venta.tipo_comprobante === "NOTA_CREDITO" ? "nota de crédito" : "venta"}
            </DialogTitle>
          </DialogHeader>
          {/* Anular una nota interna NO genera otra nota: la revierte. Decir lo
              contrario haría buscar en el listado un comprobante que no existe. */}
          {anularDlg?.venta.tipo_comprobante === "NOTA_CREDITO" ? (
            <p className="text-sm">
              ¿Confirmás anular <strong>{anularDlg?.venta.numero_comprobante}</strong>? Se va a
              revertir todo lo que hizo: sale de nuevo el stock que había devuelto, se le saca el
              crédito al cliente y la plata devuelta vuelve a la caja de hoy. No se genera ningún
              comprobante nuevo.
            </p>
          ) : (
            <p className="text-sm">
              ¿Confirmás anular <strong>{anularDlg?.venta.numero_comprobante}</strong>? Se generará
              una nota de crédito y se devolverá el stock automáticamente.
            </p>
          )}
          {/* Si el comprobante ya se declaró, anularlo acá NO lo anula ante AFIP:
              eso lo hace la nota de crédito, que es un segundo paso y hay que
              emitirla. Mientras tanto AFIP sigue teniendo la factura como válida. */}
          {anularDlg?.venta && requiereAdvertenciaAnulacionProduccion(anularDlg.venta) && (
            <div className="flex items-start gap-2 p-3 rounded border border-warning/40 bg-warning/5 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div>
                Esta factura ya tiene CAE. Para AFIP sigue siendo válida hasta que{" "}
                <strong>emitas la nota de crédito</strong>, que te va a quedar en el listado como
                pendiente. Acordate de hacerlo: AFIP sólo la acepta dentro de los{" "}
                {VENTANA_AFIP_DIAS} días.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAnularDlg(null)}
              disabled={bloqueoAnulacion}
              className="min-h-11 min-w-11"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={confirmarAnulacion}
              disabled={bloqueoAnulacion || !anularDlg}
              className="min-h-11 min-w-11"
            >
              Anular
            </Button>
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
    esNotaInterna(
      venta.tipo_comprobante,
      venta.afip_cbte_asoc_id,
      venta.periodo_asoc_desde,
      venta.periodo_asoc_hasta,
    )
  ) {
    return (
      <span title="Documento interno: no se declara a AFIP">
        <StatusPill tone="info">Interno</StatusPill>
      </span>
    );
  }
  if (venta.cae) {
    // Un CAE de homologación o simulado también tiene 14 dígitos. La validez
    // efectiva —no la apariencia del número— define color y texto.
    const descripcion = describirCaeLegacy(venta);
    if (!descripcion) return <StatusPill tone="neutral">Sin emitir</StatusPill>;
    return (
      <div className="space-y-0.5 text-xs" title={descripcion.title ?? undefined}>
        <StatusPill tone={descripcion.tone}>
          <span className="font-mono">{venta.cae}</span>
        </StatusPill>
        <div className="text-muted-foreground">{descripcion.detalle}</div>
      </div>
    );
  }
  if (venta.afip_estado === "ERROR") {
    return (
      <span title="La emisión fiscal requiere revisión. Abrí la cola fiscal para ver el estado y la acción recomendada.">
        <StatusPill tone="danger" icon={<AlertTriangle className="h-2.5 w-2.5" />}>
          ERROR
        </StatusPill>
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
        <StatusPill tone="warning">
          {restantes === 0 ? "Último día" : `Quedan ${restantes} días`}
        </StatusPill>
      </span>
    );
  }
  return <StatusPill tone="neutral">Sin emitir</StatusPill>;
}
