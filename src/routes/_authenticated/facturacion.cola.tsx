import { useEffect, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { StatusPill } from "@/components/app/status-pill";
import { ColaFiscalFiltros } from "@/components/fiscal/cola-fiscal-filtros";
import { ColaFiscalTabla } from "@/components/fiscal/cola-fiscal-tabla";
import {
  DialogoEmisionFiscal,
  type ContextoDialogoEmision,
} from "@/components/fiscal/dialogo-emision-fiscal";
import {
  parsePreviewEmisionFiscalAutoritativa,
  parseRespuestaConfirmacionFiscal,
  parseResultadoConciliacionFiscal,
  parseResultadoLiberacionFiscal,
  type ResultadoEmisionFiscalUi,
} from "@/components/fiscal/dialogo-emision-contract";
import { Button } from "@/components/ui/button";
import { DialogoDetalleVenta, type VentaDetalle } from "@/components/ventas/dialogo-detalle-venta";
import { supabase } from "@/integrations/supabase/client";
import {
  listarColaFiscal,
  listarReceptoresFiscales,
  type ColaFiscalFila,
} from "@/lib/fiscal/cola.functions";
import {
  accionesColaHabilitadas,
  actualizarBusquedaCola,
  clasificarInteraccionCola,
  cerrarResultadoCola,
  crearActualizadorBusquedaCola,
  debeRefrescarCola,
  huellaConsultaCola,
  normalizarBusquedaCola,
  presentarEstadoColaFiscal,
  presentarResultadoCola,
  resolverSeleccionColaFiscal,
  resolverTabAutoritativo,
  type BusquedaColaFiscal,
  type ResultadoColaFiscal,
  type SeleccionColaFiscal,
  type TabColaFiscal,
} from "@/lib/fiscal/cola-ui";
import {
  emitirComprobante,
  liberarClaimFiscal,
  previsualizarEmisionFiscal,
  reconciliarComprobante,
} from "@/lib/fiscal.functions";
import type { ReceptorHeredadoVista } from "@/components/fiscal/receptor-fiscal-form";
import type { SelectorReceptorFiscal } from "@/lib/fiscal/receptor";

const TAMANO_PAGINA = 25;
const TABS: Array<{ value: TabColaFiscal; label: string }> = [
  { value: "pendientes", label: "Pendientes" },
  { value: "revisar", label: "A revisar" },
  { value: "emitidas", label: "Emitidas" },
  { value: "historial", label: "Historial" },
];

export const Route = createFileRoute("/_authenticated/facturacion/cola")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => normalizarBusquedaCola(search),
  beforeLoad: async ({ context }) => {
    const acceso = context.accesoFiscal;
    if (!acceso.facturacionV2Habilitada || (!acceso.isAdmin && !acceso.puedeFacturar)) {
      throw redirect({ to: acceso.isAdmin ? "/facturacion/configuracion" : "/" });
    }
  },
  component: ColaFiscalPage,
});

function mensajeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function esMantenimiento(value: unknown): value is { estado: "MANTENIMIENTO"; mensaje: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.estado === "MANTENIMIENTO" && typeof row.mensaje === "string";
}

function receptorHeredado(row: ColaFiscalFila): ReceptorHeredadoVista | null {
  const tipos = new Set(["CUIT", "CUIL", "DNI", "CDI", "SIN_IDENTIFICAR"]);
  const condiciones = new Set([
    "RESPONSABLE_INSCRIPTO",
    "MONOTRIBUTO",
    "EXENTO",
    "CONSUMIDOR_FINAL",
  ]);
  if (
    !row.receptor_razon_social ||
    !row.receptor_tipo_documento ||
    !tipos.has(row.receptor_tipo_documento) ||
    !row.receptor_condicion_iva ||
    !condiciones.has(row.receptor_condicion_iva)
  ) {
    return null;
  }
  return {
    razonSocial: row.receptor_razon_social,
    tipoDocumento: row.receptor_tipo_documento as ReceptorHeredadoVista["tipoDocumento"],
    numeroDocumento: row.receptor_numero_documento,
    condicionIva: row.receptor_condicion_iva as ReceptorHeredadoVista["condicionIva"],
    domicilio: null,
  };
}

function contextoDialogo(row: ColaFiscalFila): ContextoDialogoEmision {
  return {
    comprador: {
      razonSocial: row.cliente_razon_social ?? "Comprador sin razón social",
      documento: row.documento_comercial,
    },
    emisor: {
      razonSocial: row.emisor_razon_social ?? "Emisor a confirmar",
      cuit: row.emisor_cuit ?? "a confirmar",
    },
    sucursal: {
      nombre: row.sucursal_nombre ?? "Sucursal a confirmar",
      puntoVenta: row.afip_punto_venta,
      modo:
        row.afip_validez === "PRODUCCION"
          ? "PRODUCCION"
          : row.afip_validez === "HOMOLOGACION" || row.afip_validez === "SIMULADA"
            ? "HOMOLOGACION"
            : null,
    },
    tipoComprobante: row.tipo_comprobante,
    receptorHeredado: receptorHeredado(row),
  };
}

function accionFila(row: ColaFiscalFila, esAdmin: boolean): string {
  try {
    return presentarEstadoColaFiscal({
      estado: row.afip_estado,
      fase: row.afip_fase,
      claimVencido: row.claim_vencido,
      numeroFiscal: row.afip_numero,
      ventaAntigua: row.venta_antigua,
      legacyIncompleto: row.afip_legacy_incompleto,
      esAdmin,
    }).accion;
  } catch {
    return "Requiere administrador";
  }
}

function resultadoDespuesDeEmitir(value: ResultadoEmisionFiscalUi): ResultadoColaFiscal | null {
  if (value.estado === "APROBADO") return "factura_aprobada";
  if (value.estado === "EN_CURSO") return "venta_creada_factura_pendiente";
  if (value.estado === "RECONCILIAR" || value.estado === "BLOQUEADO") {
    return "venta_creada_requiere_revision";
  }
  return null;
}

function BannerResultado({
  search,
  fila,
  esAdmin,
  onCerrar,
}: {
  search: BusquedaColaFiscal;
  fila: ColaFiscalFila | undefined;
  esAdmin: boolean;
  onCerrar(): void;
}) {
  if (!search.resultado) return null;
  const requiereAdministrador = fila
    ? accionFila(fila, esAdmin) === "Requiere administrador"
    : false;
  const vista = presentarResultadoCola(search.resultado, requiereAdministrador);
  const aprobada = search.resultado === "factura_aprobada";

  return (
    <section
      aria-live="polite"
      className={`flex items-start gap-3 rounded-xl border p-4 ${
        aprobada
          ? "border-success/30 bg-success/10 text-success"
          : "border-warning/35 bg-warning/10 text-foreground"
      }`}
    >
      {aprobada ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">{vista.titulo}</h2>
          {vista.requiereAdministrador ? (
            <StatusPill tone="danger">Requiere administrador</StatusPill>
          ) : null}
        </div>
        <p className="mt-1 text-sm">{vista.detalle}</p>
        {fila ? (
          <p className="mt-1 text-xs font-medium">
            Estado actual: {fila.afip_estado} · Acción: {accionFila(fila, esAdmin)}
          </p>
        ) : (
          <p className="mt-1 text-xs">Consultando el estado autoritativo de la venta…</p>
        )}
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 shrink-0"
        aria-label="Cerrar resultado"
        title="Cerrar resultado"
        onClick={onCerrar}
      >
        <X />
      </Button>
    </section>
  );
}

function ColaFiscalPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { accesoFiscal } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const esAdmin = accesoFiscal.isAdmin;
  const listarCola = useServerFn(listarColaFiscal);
  const listarFavoritos = useServerFn(listarReceptoresFiscales);
  const previsualizar = useServerFn(previsualizarEmisionFiscal);
  const emitir = useServerFn(emitirComprobante);
  const reconciliar = useServerFn(reconciliarComprobante);
  const liberar = useServerFn(liberarClaimFiscal);
  const [seleccion, setSeleccion] = useState<SeleccionColaFiscal<ColaFiscalFila> | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [mensajeAccion, setMensajeAccion] = useState<string | null>(null);
  const [detalleSeleccionado, setDetalleSeleccionado] = useState<{
    ventaId: string;
    permitirDescarga: boolean;
  } | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);

  const inputCola = {
    tab: search.tab,
    page: search.page,
    pageSize: TAMANO_PAGINA,
    desde: search.desde,
    hasta: search.hasta,
    sucursal_id: search.sucursal,
    emisor_id: search.emisor,
    documento: search.documento,
    estado: search.estado as
      | "SIN_FACTURAR"
      | "EMITIENDO"
      | "APROBADO"
      | "ERROR_CORREGIBLE"
      | "RECONCILIAR"
      | "CANCELADO"
      | "BLOQUEADO"
      | "PENDIENTE"
      | "ERROR"
      | undefined,
    venta_id: search.venta,
  };

  const cola = useQuery({
    queryKey: ["cola-fiscal", inputCola],
    queryFn: () => listarCola({ data: inputCola }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (debeRefrescarCola(query.state.data?.filas ?? []) ? 4_000 : false),
  });

  const filas = cola.data?.filas ?? [];
  const accionesHabilitadas = accionesColaHabilitadas({
    isPlaceholderData: cola.isPlaceholderData,
    isFetching: cola.isFetching,
  });
  const huellaConsulta = huellaConsultaCola(search);
  const seleccionVigente = resolverSeleccionColaFiscal({
    seleccion,
    huellaConsulta,
    isPlaceholderData: cola.isPlaceholderData,
    filas,
  });
  const seleccionada = seleccionVigente?.fila ?? null;

  useEffect(() => {
    if (seleccion !== seleccionVigente) setSeleccion(seleccionVigente);
  }, [seleccion, seleccionVigente]);

  const favoritos = useQuery({
    queryKey: ["receptores-fiscales", seleccionada?.sucursal_id ?? null],
    queryFn: () =>
      listarFavoritos({ data: { sucursal_id: seleccionada?.sucursal_id ?? undefined } }),
    enabled: seleccionada !== null,
  });
  const detalleVenta = useQuery({
    queryKey: ["venta-detalle-cola", detalleSeleccionado?.ventaId ?? null],
    enabled: detalleSeleccionado !== null,
    queryFn: async () => {
      if (!detalleSeleccionado) throw new Error("No hay una venta seleccionada para ver.");
      const { data, error } = await supabase
        .from("ventas")
        .select("*, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,telefono)")
        .eq("id", detalleSeleccionado.ventaId)
        .single();
      if (error || !data) throw new Error("No se pudo cargar el detalle de la venta.");
      return data as unknown as VentaDetalle;
    },
  });
  const filaResultado = search.venta
    ? filas.find((fila) => fila.venta_id === search.venta)
    : undefined;
  const tabAutoritativo = accionesHabilitadas
    ? resolverTabAutoritativo(search.tab, search.venta, filas)
    : search.tab;

  useEffect(() => {
    if (tabAutoritativo === search.tab) return;
    void navigate({
      search: crearActualizadorBusquedaCola({ tab: tabAutoritativo }),
      replace: true,
    });
  }, [navigate, search, tabAutoritativo]);

  const accion = useMutation({
    mutationFn: async ({ row, nombre }: { row: ColaFiscalFila; nombre: string }) => {
      if (nombre === "Verificar con ARCA") {
        const respuesta = await reconciliar({ data: { venta_id: row.venta_id } });
        if (esMantenimiento(respuesta)) throw new Error(respuesta.mensaje);
        return parseResultadoConciliacionFiscal(respuesta);
      }
      if (nombre === "Liberar claim verificado") {
        const respuesta = await liberar({ data: { venta_id: row.venta_id } });
        if (esMantenimiento(respuesta)) throw new Error(respuesta.mensaje);
        return parseResultadoLiberacionFiscal(respuesta);
      }
      throw new Error("La acción fiscal seleccionada no está habilitada en esta tarea.");
    },
    onMutate: () => {
      setErrorAccion(null);
      setMensajeAccion(null);
    },
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["cola-fiscal"] });
      setMensajeAccion(
        variables.nombre === "Liberar claim verificado"
          ? "El claim verificado fue liberado."
          : result.estado === "APROBADO"
            ? "ARCA confirmó y recuperó el comprobante."
            : "La verificación fiscal terminó; revisá el estado actualizado.",
      );
    },
    onError: (error) =>
      setErrorAccion(mensajeError(error, "No se pudo completar la acción fiscal.")),
  });

  const cambiarSearch = (cambios: Partial<BusquedaColaFiscal>, replace = false) =>
    navigate({ search: actualizarBusquedaCola(search, cambios), replace });

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Libro fiscal operativo</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              La venta y el cobro ya existen; esta cola gestiona solamente su comprobante fiscal.
            </p>
          </div>
          <StatusPill tone="info">Actualización autoritativa</StatusPill>
        </div>
      </section>

      <BannerResultado
        search={search}
        fila={filaResultado}
        esAdmin={esAdmin}
        onCerrar={() => void navigate({ search: cerrarResultadoCola(search), replace: true })}
      />

      <div aria-live="polite">
        {errorAccion ? <p className="text-sm font-medium text-destructive">{errorAccion}</p> : null}
        {detalleVenta.error ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/35 bg-destructive/5 p-3"
            role="alert"
          >
            <p className="mr-auto text-sm font-medium text-destructive">
              {mensajeError(detalleVenta.error, "No se pudo cargar el detalle de la venta.")}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={detalleVenta.isFetching}
              onClick={() => void detalleVenta.refetch()}
            >
              Reintentar detalle
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDetalleSeleccionado(null)}>
              Cerrar detalle
            </Button>
          </div>
        ) : null}
        {mensajeAccion ? <p className="text-sm font-medium text-success">{mensajeAccion}</p> : null}
      </div>

      <div
        role="tablist"
        aria-label="Estados de la cola fiscal"
        className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-2 shadow-card sm:grid-cols-4"
      >
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={search.tab === tab.value}
            className={`flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              search.tab === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted/45 hover:bg-muted"
            }`}
            onClick={() =>
              void cambiarSearch({ tab: tab.value, venta: undefined, resultado: undefined })
            }
          >
            <span>{tab.label}</span>
            <span className="font-mono text-xs tabular-nums">
              {cola.data?.conteos[tab.value] ?? "—"}
            </span>
          </button>
        ))}
      </div>

      <ColaFiscalFiltros
        key={`${search.desde ?? ""}|${search.hasta ?? ""}|${search.sucursal ?? ""}|${search.emisor ?? ""}|${search.documento ?? ""}|${search.estado ?? ""}`}
        initial={search}
        esAdmin={esAdmin}
        sucursales={cola.data?.filtrosDisponibles.sucursales ?? []}
        emisores={cola.data?.filtrosDisponibles.emisores ?? []}
        disabled={cola.isLoading}
        onAplicar={(filtros) =>
          void cambiarSearch({ ...filtros, venta: undefined, resultado: undefined })
        }
        onLimpiar={() =>
          void cambiarSearch({
            desde: undefined,
            hasta: undefined,
            sucursal: undefined,
            emisor: undefined,
            documento: undefined,
            estado: undefined,
            venta: undefined,
            resultado: undefined,
          })
        }
      />

      <ColaFiscalTabla
        filas={filas}
        esAdmin={esAdmin}
        loading={cola.isLoading}
        updating={cola.isFetching && !cola.isLoading}
        accionesHabilitadas={accionesHabilitadas}
        accionPendienteId={accion.isPending ? accion.variables?.row.venta_id : null}
        error={cola.error ? mensajeError(cola.error, "No se pudo cargar la cola fiscal.") : null}
        onRetry={() => void cola.refetch()}
        onAccion={(row, nombre, disparador) => {
          if (!accionesHabilitadas) return;
          setErrorAccion(null);
          setMensajeAccion(null);
          const interaccion = clasificarInteraccionCola(nombre);
          if (interaccion === "EMISION") {
            returnFocusRef.current = disparador;
            setSeleccion({ fila: row, huellaConsulta });
            return;
          }
          if (interaccion === "DETALLE_DESCARGA" || interaccion === "DETALLE_LECTURA") {
            returnFocusRef.current = disparador;
            setDetalleSeleccionado({
              ventaId: row.venta_id,
              permitirDescarga: interaccion === "DETALLE_DESCARGA",
            });
            return;
          }
          if (interaccion !== "TRANSICION") return;
          accion.mutate({ row, nombre });
        }}
      />

      <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm sm:flex-row">
        <p className="text-muted-foreground">
          {cola.data?.total ?? 0} registros · página {cola.data?.page ?? search.page} de{" "}
          {Math.max(cola.data?.paginas ?? 0, 1)}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={search.page <= 1 || cola.isLoading || !accionesHabilitadas}
            onClick={() => void cambiarSearch({ page: search.page - 1 })}
          >
            <ChevronLeft /> Anterior
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={
              search.page >= (cola.data?.paginas ?? 0) || cola.isLoading || !accionesHabilitadas
            }
            onClick={() => void cambiarSearch({ page: search.page + 1 })}
          >
            Siguiente <ChevronRight />
          </Button>
        </div>
      </div>

      {seleccionada && accionesHabilitadas ? (
        <DialogoEmisionFiscal
          open
          contexto={contextoDialogo(seleccionada)}
          favoritos={favoritos.data ?? []}
          returnFocusRef={returnFocusRef}
          onOpenChange={(open) => {
            if (!open) setSeleccion(null);
          }}
          onPrevisualizar={(receptor: SelectorReceptorFiscal) =>
            previsualizar({
              data: {
                origen: "VENTA_EXISTENTE",
                venta_id: seleccionada.venta_id,
                receptor,
              },
            }).then((respuesta) => {
              if (esMantenimiento(respuesta)) throw new Error(respuesta.mensaje);
              return parsePreviewEmisionFiscalAutoritativa(respuesta);
            })
          }
          onConfirmar={async ({ receptor, confirmaVentaAntigua, huellaConfirmacion }) => {
            const resultado = await emitir({
              data: {
                venta_id: seleccionada.venta_id,
                receptor,
                confirma_venta_antigua: confirmaVentaAntigua,
                huella_confirmacion: huellaConfirmacion,
              },
            });
            if (esMantenimiento(resultado)) throw new Error(resultado.mensaje);
            const respuesta = parseRespuestaConfirmacionFiscal(resultado);
            if (respuesta.estado === "ERROR_CORREGIBLE") {
              await queryClient.invalidateQueries({ queryKey: ["cola-fiscal"] });
              throw new Error(respuesta.mensaje);
            }
            return respuesta;
          }}
          onCompletada={(resultado) => {
            const resultadoUrl = resultadoDespuesDeEmitir(resultado);
            const ventaId = seleccionada.venta_id;
            setSeleccion(null);
            void queryClient.invalidateQueries({ queryKey: ["cola-fiscal"] });
            if (resultadoUrl) {
              void navigate({
                search: crearActualizadorBusquedaCola({
                  venta: ventaId,
                  resultado: resultadoUrl,
                }),
                replace: true,
              });
            }
          }}
        />
      ) : null}
      {detalleSeleccionado ? (
        <DialogoDetalleVenta
          venta={detalleVenta.data ?? null}
          permitirDescarga={detalleSeleccionado.permitirDescarga}
          returnFocusRef={returnFocusRef}
          onClose={() => setDetalleSeleccionado(null)}
        />
      ) : null}
    </div>
  );
}
