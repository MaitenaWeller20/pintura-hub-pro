import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { CondicionIva } from "@/lib/fiscal/codigos";
import type { SelectorReceptorFiscal } from "@/lib/fiscal/receptor";
import { crearErrorFiscalUsuario, mensajeErrorFiscal } from "@/lib/fiscal/error-usuario";
import {
  ReceptorFiscalForm,
  type ReceptorFormulario,
  type ReceptorHeredadoVista,
} from "./receptor-fiscal-form";
import { ResumenEmisionFiscal, type PreviewEmisionFiscal } from "./resumen-emision-fiscal";
import { textoValidezFiscal } from "@/lib/fiscal/validez-ui";
import type { ModalidadNcPeriodo, ResolucionNcPeriodo } from "@/lib/fiscal/nota-credito-periodo";
import {
  adaptarReceptorFormularioALetra,
  cambiarLetraConfirmacion,
  cambiarReceptorConfirmacion,
  crearControlSolicitudPreview,
  crearEstadoConfirmacionFiscal,
  esSolicitudPreviewActual,
  finalizarSolicitudPreview,
  iniciarSolicitudPreview,
  invalidarSolicitudPreview,
  invalidarHuellaConfirmacion,
  registrarPreviewConfirmacion,
  registrarReconfirmacion,
  type LetraSolicitada,
} from "./dialogo-emision-state";
import {
  despacharRespuestaConfirmacionFiscal,
  manejarErrorCorregibleDialogo,
  parsePreviewEmisionFiscal,
  reconfirmarPreviewEmisionFiscal,
  type ResultadoEmisionFiscalUi,
} from "./dialogo-emision-contract";
import {
  validarSelectorReceptorFiscal,
  type CampoReceptorFiscal,
} from "./dialogo-emision-validacion";
import {
  bloqueaAccionesPorConsultaPadron,
  claveConsultaPadronId,
  claveParaConsultaPadron,
  crearControlConsultaPadron,
  estadoConsultaPadronEfectivo,
  invalidarConsultaPadron,
  mismaClaveConsultaPadron,
  programarConsultaPadron,
  resultadoConsultaCuitPadronSchema,
  type ClaveConsultaPadron,
  type EstadoConsultaPadronUi,
} from "./padron-receptor";

export type ContextoDialogoEmision = {
  comprador: {
    razonSocial: string;
    documento: string | null;
    condicionIva: CondicionIva | null;
  };
  emisor: { razonSocial: string; cuit: string };
  sucursal: {
    id: string;
    nombre: string;
    puntoVenta: number | null;
    modo: "PRODUCCION" | "HOMOLOGACION" | null;
  };
  tipoComprobante: string;
  receptorHeredado?: ReceptorHeredadoVista | null;
  asociacionPeriodo?: {
    desde: string;
    hasta: string;
    modalidad: ModalidadNcPeriodo;
    motivo: string;
    resolucion: ResolucionNcPeriodo;
  } | null;
};

function SincronizarPadronReceptor({
  clave,
  control,
  onConsultarCuit,
  onIniciar,
  onEstado,
}: {
  clave: ClaveConsultaPadron | null;
  control: ReturnType<typeof crearControlConsultaPadron>;
  onConsultarCuit(input: { sucursalId: string; cuit: string }): Promise<unknown>;
  onIniciar(): void;
  onEstado(estado: EstadoConsultaPadronUi): void;
}) {
  const consultarRef = useRef(onConsultarCuit);
  const iniciarRef = useRef(onIniciar);
  const claveRef = useRef(clave);
  const claveId = claveConsultaPadronId(clave);

  useLayoutEffect(() => {
    consultarRef.current = onConsultarCuit;
  }, [onConsultarCuit]);
  useLayoutEffect(() => {
    iniciarRef.current = onIniciar;
  }, [onIniciar]);
  useLayoutEffect(() => {
    claveRef.current = clave;
  }, [clave, claveId]);

  useLayoutEffect(() => {
    iniciarRef.current();
    const claveProgramada = claveRef.current;
    if (!claveProgramada) {
      invalidarConsultaPadron(control);
      onEstado({ estado: "SIN_CUIT" });
      return;
    }

    const solicitud = programarConsultaPadron(control, claveProgramada, {
      consultar: async () =>
        resultadoConsultaCuitPadronSchema.parse(
          await consultarRef.current({
            sucursalId: claveProgramada.sucursalId,
            cuit: claveProgramada.cuit,
          }),
        ),
      onResultado(resultado, claveConsultada) {
        onEstado(
          resultado.estado === "INACTIVO"
            ? { estado: "INACTIVO", clave: claveConsultada }
            : {
                estado: "VERIFICADO",
                clave: claveConsultada,
                receptor: resultado.receptor,
              },
        );
      },
      onError(cause, claveConsultada) {
        onEstado({
          estado: "ERROR",
          clave: claveConsultada,
          mensaje: mensajeErrorFiscal(cause, "REVISION"),
        });
      },
    });
    return solicitud.cancelar;
  }, [claveId, control, onEstado]);

  return null;
}

function letraParaNota(receptor: ReceptorHeredadoVista | null | undefined): LetraSolicitada {
  return receptor?.condicionIva === "RESPONSABLE_INSCRIPTO" ||
    receptor?.condicionIva === "MONOTRIBUTO"
    ? "A"
    : "B";
}

function enfocarErrorReceptor(campo: CampoReceptorFiscal): void {
  if (typeof document === "undefined") return;
  const idPorCampo: Record<CampoReceptorFiscal, string> = {
    cliente_comercial: "receptor-cliente-comercial",
    receptor: "receptor-favorito",
    tipo_documento: "receptor-tipo-documento",
    numero_documento: "receptor-numero-documento",
    razon_social: "receptor-razon-social",
    condicion_iva: "receptor-condicion-iva",
    confirmacion: "confirmar-datos-receptor",
  };
  document.getElementById(idPorCampo[campo])?.focus();
}

export function DialogoEmisionFiscal({
  open,
  contexto,
  favoritos,
  returnFocusRef,
  puedeConfirmarVentaAntigua = false,
  onOpenChange,
  onConsultarCuit,
  onPrevisualizar,
  onPrevisualizarPeriodo,
  onConfirmar,
  onConfirmarPeriodo,
  onCompletada,
}: {
  open: boolean;
  contexto: ContextoDialogoEmision;
  favoritos: ReceptorFiscalFavorito[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  puedeConfirmarVentaAntigua?: boolean;
  onOpenChange(open: boolean): void;
  onConsultarCuit?(input: { sucursalId: string; cuit: string }): Promise<unknown>;
  onPrevisualizar(input: {
    receptor: SelectorReceptorFiscal;
    letraSolicitada: LetraSolicitada;
  }): Promise<unknown>;
  onPrevisualizarPeriodo?(input: { receptor: SelectorReceptorFiscal }): Promise<unknown>;
  onConfirmar(input: {
    receptor: SelectorReceptorFiscal;
    letraSolicitada: LetraSolicitada;
    confirmaVentaAntigua: boolean;
    huellaConfirmacion: string;
  }): Promise<unknown>;
  onConfirmarPeriodo?(input: {
    receptor: SelectorReceptorFiscal;
    confirmaVentaAntigua: boolean;
    huellaConfirmacion: string;
  }): Promise<unknown>;
  onCompletada?(result: ResultadoEmisionFiscalUi): void;
}) {
  const esNota =
    contexto.tipoComprobante === "NOTA_CREDITO" || contexto.tipoComprobante === "NOTA_DEBITO";
  const esNcPeriodo = contexto.tipoComprobante === "NOTA_CREDITO" && !!contexto.asociacionPeriodo;
  const consultarCuit =
    onConsultarCuit ??
    (async (input: { sucursalId: string; cuit: string }) => {
      const { consultarCuitPadronArca } = await import("@/lib/fiscal.functions");
      return consultarCuitPadronArca({
        data: { sucursal_id: input.sucursalId, cuit: input.cuit },
      });
    });
  const receptorInicial: ReceptorFormulario =
    esNota && !esNcPeriodo ? { origen: "COMPROBANTE_ORIGINAL" } : { origen: "CLIENTE_COMERCIAL" };
  const letraInicial = esNota && !esNcPeriodo ? letraParaNota(contexto.receptorHeredado) : null;
  const [receptor, setReceptor] = useState<ReceptorFormulario>(receptorInicial);
  const [confirmacion, setConfirmacion] = useState(() =>
    crearEstadoConfirmacionFiscal(letraInicial),
  );
  const [preview, setPreview] = useState<PreviewEmisionFiscal | null>(null);
  const [confirmaVentaAntigua, setConfirmaVentaAntigua] = useState(false);
  const [confirmaPeriodo, setConfirmaPeriodo] = useState(false);
  const [previsualizando, setPrevisualizando] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erroresReceptor, setErroresReceptor] = useState<
    Partial<Record<CampoReceptorFiscal, string>>
  >({});
  const [estadoConsultaPadron, setEstadoConsultaPadron] = useState<EstadoConsultaPadronUi>({
    estado: "SIN_CUIT",
  });
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const previewControlRef = useRef(crearControlSolicitudPreview());
  const emitiendoRef = useRef(false);
  const padronControlRef = useRef(crearControlConsultaPadron());

  const claveConsultaPadron =
    esNota && !esNcPeriodo
      ? null
      : claveParaConsultaPadron({
          sucursalId: contexto.sucursal.id,
          receptor,
          cliente: contexto.comprador,
          favoritos,
        });
  const cuitActual = claveConsultaPadron?.cuit ?? null;
  const estadoPadronEfectivo = estadoConsultaPadronEfectivo(
    claveConsultaPadron,
    estadoConsultaPadron,
  );

  const limpiarConfirmacionPorConsulta = useCallback(() => {
    invalidarSolicitudPreview(previewControlRef.current);
    setPrevisualizando(false);
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setConfirmaPeriodo(false);
    setConfirmacion(invalidarHuellaConfirmacion);
  }, []);

  const marcarCambioConsulta = (siguiente: ReceptorFormulario) => {
    const siguienteClave = claveParaConsultaPadron({
      sucursalId: contexto.sucursal.id,
      receptor: siguiente,
      cliente: contexto.comprador,
      favoritos,
    });
    if (mismaClaveConsultaPadron(claveConsultaPadron, siguienteClave)) return;
    invalidarConsultaPadron(padronControlRef.current);
    setEstadoConsultaPadron(
      siguienteClave
        ? {
            estado: "CONSULTANDO",
            clave: siguienteClave,
            token: padronControlRef.current.secuencia,
          }
        : { estado: "SIN_CUIT" },
    );
  };

  const reiniciar = () => {
    setReceptor(receptorInicial);
    setConfirmacion(crearEstadoConfirmacionFiscal(letraInicial));
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setPrevisualizando(false);
    setError(null);
    setErroresReceptor({});
    invalidarSolicitudPreview(previewControlRef.current);
    invalidarConsultaPadron(padronControlRef.current);
    setEstadoConsultaPadron({ estado: "SIN_CUIT" });
  };

  const cerrar = () => {
    if (emitiendoRef.current) return;
    reiniciar();
    onOpenChange(false);
  };

  const cambiarReceptor = (siguiente: ReceptorFormulario) => {
    invalidarSolicitudPreview(previewControlRef.current);
    setPrevisualizando(false);
    setReceptor(siguiente);
    marcarCambioConsulta(siguiente);
    setConfirmacion((actual) => cambiarReceptorConfirmacion(actual));
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setError(null);
    setErroresReceptor({});
  };

  const cambiarLetra = (letraSolicitada: LetraSolicitada) => {
    if (esNota || emitiendoRef.current) return;
    setPrevisualizando(false);
    const siguienteReceptor = adaptarReceptorFormularioALetra(receptor, letraSolicitada);
    setReceptor(siguienteReceptor);
    marcarCambioConsulta(siguienteReceptor);
    setConfirmacion(
      cambiarLetraConfirmacion(confirmacion, letraSolicitada, previewControlRef.current),
    );
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setError(null);
    setErroresReceptor({});
  };

  const validarReceptor = (
    letraSolicitada: LetraSolicitada | null,
  ): SelectorReceptorFiscal | null => {
    const resultado = validarSelectorReceptorFiscal({
      value: receptor,
      confirmaDatosManuales: confirmacion.confirmaDatosManuales,
      letraSolicitada,
      clienteComercial: contexto.comprador,
      favoritos,
      estadoConsultaPadron: estadoPadronEfectivo,
      claveConsultaPadron,
    });
    if (resultado.ok) {
      setErroresReceptor({});
      return resultado.selector;
    }
    setError(null);
    setErroresReceptor({ [resultado.campo]: resultado.mensaje });
    enfocarErrorReceptor(resultado.campo);
    return null;
  };

  const preparar = async () => {
    const letraSolicitada = esNcPeriodo
      ? ({ origen: "AUTOMATICA_NC_PERIODO" } as const)
      : confirmacion.letraSolicitada;
    if (!letraSolicitada) {
      setError("Elegí si querés emitir una factura A o una factura B.");
      return;
    }
    const selector = validarReceptor(typeof letraSolicitada === "string" ? letraSolicitada : null);
    if (!selector) return;
    const token = iniciarSolicitudPreview(previewControlRef.current);
    if (token === null) return;
    setPrevisualizando(true);
    setError(null);
    try {
      const resultado = parsePreviewEmisionFiscal(
        await (esNcPeriodo
          ? onPrevisualizarPeriodo
            ? onPrevisualizarPeriodo({ receptor: selector })
            : Promise.reject(new Error("Falta la revisión fiscal de la nota por período."))
          : typeof letraSolicitada === "string"
            ? onPrevisualizar({ receptor: selector, letraSolicitada })
            : Promise.reject(new Error("Falta la letra fiscal."))),
        esNota || typeof letraSolicitada !== "string" ? undefined : letraSolicitada,
      );
      if (!esSolicitudPreviewActual(previewControlRef.current, token)) return;
      setPreview(resultado);
      setConfirmacion((actual) =>
        registrarPreviewConfirmacion(actual, resultado.huella_confirmacion),
      );
    } catch (cause) {
      if (esSolicitudPreviewActual(previewControlRef.current, token)) {
        setError(mensajeErrorFiscal(cause, "REVISION"));
      }
    } finally {
      if (esSolicitudPreviewActual(previewControlRef.current, token)) {
        setPrevisualizando(false);
      }
      finalizarSolicitudPreview(previewControlRef.current, token);
    }
  };

  const confirmar = async () => {
    if (
      !preview ||
      !confirmacion.huellaConfirmacion ||
      (!esNcPeriodo && !confirmacion.letraSolicitada) ||
      emitiendoRef.current
    )
      return;
    emitiendoRef.current = true;
    setEmitiendo(true);
    setError(null);
    try {
      const letraSolicitada = esNcPeriodo
        ? ({ origen: "AUTOMATICA_NC_PERIODO" } as const)
        : confirmacion.letraSolicitada;
      if (!letraSolicitada) return;
      const selector = validarReceptor(
        typeof letraSolicitada === "string" ? letraSolicitada : null,
      );
      if (!selector) return;
      const respuesta = await (esNcPeriodo
        ? onConfirmarPeriodo
          ? onConfirmarPeriodo({
              receptor: selector,
              confirmaVentaAntigua,
              huellaConfirmacion: confirmacion.huellaConfirmacion,
            })
          : Promise.reject(new Error("Falta la emisión fiscal de la nota por período."))
        : typeof letraSolicitada === "string"
          ? onConfirmar({
              receptor: selector,
              letraSolicitada,
              confirmaVentaAntigua,
              huellaConfirmacion: confirmacion.huellaConfirmacion,
            })
          : Promise.reject(new Error("Falta la letra fiscal.")));
      despacharRespuestaConfirmacionFiscal(respuesta, {
        onReconfirmacion(resultado) {
          setPreview(
            reconfirmarPreviewEmisionFiscal(
              preview,
              resultado,
              esNota || typeof letraSolicitada !== "string" ? undefined : letraSolicitada,
            ),
          );
          setConfirmacion((actual) =>
            registrarReconfirmacion(actual, resultado.huella_confirmacion),
          );
          setConfirmaVentaAntigua(false);
          setError(mensajeErrorFiscal(crearErrorFiscalUsuario("RECONFIRMACION"), "EMISION"));
        },
        onErrorCorregible(resultado) {
          manejarErrorCorregibleDialogo(resultado, {
            invalidarPreview: () => invalidarSolicitudPreview(previewControlRef.current),
            limpiarPreview: () => setPreview(null),
            limpiarHuella: () =>
              setConfirmacion((actual) => ({
                ...actual,
                huellaConfirmacion: null,
                requiereSegundaConfirmacion: false,
              })),
            limpiarConfirmacionVentaAntigua: () => setConfirmaVentaAntigua(false),
            mostrarError: setError,
          });
        },
        onCompletada(resultado) {
          onCompletada?.(resultado);
          reiniciar();
          onOpenChange(false);
        },
      });
    } catch (cause) {
      setError(mensajeErrorFiscal(cause, "EMISION"));
    } finally {
      emitiendoRef.current = false;
      setEmitiendo(false);
    }
  };

  const consultaPadronVerificada =
    estadoPadronEfectivo.estado === "VERIFICADO" &&
    estadoPadronEfectivo.receptor.cuit === cuitActual;
  const puedeEmitir =
    preview !== null &&
    (esNcPeriodo || confirmacion.letraSolicitada !== null) &&
    confirmacion.huellaConfirmacion !== null &&
    (!preview.advertencia_demora || (puedeConfirmarVentaAntigua && confirmaVentaAntigua)) &&
    !(preview.letra === "A" && !preview.confirmacion_factura_a_permitida) &&
    (receptor.origen !== "MANUAL" ||
      confirmacion.confirmaDatosManuales ||
      consultaPadronVerificada) &&
    (!esNcPeriodo || confirmaPeriodo);
  const consultaPadronBloquea =
    !esNota && bloqueaAccionesPorConsultaPadron(claveConsultaPadron, estadoPadronEfectivo);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (emitiendoRef.current) return;
        if (!next) reiniciar();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] max-w-3xl overflow-hidden p-0"
        data-testid="dialogo-emision-fiscal"
        closeDisabled={emitiendo}
        hideClose={emitiendo}
        onOpenAutoFocus={(event) => {
          if (!esNota) {
            event.preventDefault();
            initialFocusRef.current?.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        {open && (!esNota || esNcPeriodo) ? (
          <SincronizarPadronReceptor
            clave={claveConsultaPadron}
            control={padronControlRef.current}
            onConsultarCuit={consultarCuit}
            onIniciar={limpiarConfirmacionPorConsulta}
            onEstado={setEstadoConsultaPadron}
          />
        ) : null}
        <div className="px-4 pt-5 sm:px-6">
          <DialogHeader>
            <DialogTitle>Revisar y emitir comprobante</DialogTitle>
            <DialogDescription>
              Facturar no vuelve a cobrar ni modifica la deuda de la venta.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div
          className="max-h-[calc(100dvh-12rem)] space-y-5 overflow-y-auto px-4 sm:px-6"
          data-testid="dialogo-emision-scroll"
        >
          <section className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Comprador / deudor
              </p>
              <p className="font-semibold">{contexto.comprador.razonSocial}</p>
              <p className="text-xs text-muted-foreground">
                {contexto.comprador.documento ?? "Sin documento cargado"}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Emisión
              </p>
              {preview ? (
                <>
                  <p className="font-semibold">{preview.emisor_razon_social}</p>
                  <p className="text-xs text-muted-foreground">
                    CUIT {preview.emisor_cuit} · {preview.sucursal_nombre} · PV{" "}
                    {String(preview.punto_venta).padStart(5, "0")} ·{" "}
                    {textoValidezFiscal(preview.afip_validez)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  El servidor resolverá emisor, sucursal, punto de venta y ambiente al revisar.
                </p>
              )}
            </div>
          </section>

          {esNcPeriodo && contexto.asociacionPeriodo ? (
            <section
              aria-labelledby="asociacion-periodo-fiscal"
              className="rounded-xl border border-primary/30 bg-primary/5 p-4"
            >
              <h3 id="asociacion-periodo-fiscal" className="text-sm font-semibold">
                Asociación fiscal por período
              </h3>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Período</dt>
                  <dd className="font-medium">
                    {contexto.asociacionPeriodo.desde} a {contexto.asociacionPeriodo.hasta}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Modalidad</dt>
                  <dd className="font-medium">
                    {contexto.asociacionPeriodo.modalidad === "DEVOLUCION_PRODUCTOS"
                      ? "Devolución de productos"
                      : "Bonificación o ajuste"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Motivo</dt>
                  <dd>{contexto.asociacionPeriodo.motivo}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Resolución</dt>
                  <dd>
                    {contexto.asociacionPeriodo.resolucion === "REINTEGRO"
                      ? "Reintegro exacto"
                      : "Saldo a favor"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                La letra se determina automáticamente según emisor y receptor; no se puede editar.
              </p>
            </section>
          ) : null}

          {!esNota ? (
            <fieldset disabled={emitiendo} className="space-y-2">
              <legend className="text-sm font-semibold">Tipo de factura</legend>
              <p id="ayuda-letra-solicitada" className="text-xs text-muted-foreground">
                Elegí la letra antes de revisar los datos fiscales.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
                  <input
                    ref={initialFocusRef}
                    type="radio"
                    name="letra-solicitada"
                    value="A"
                    required
                    checked={confirmacion.letraSolicitada === "A"}
                    aria-describedby="ayuda-letra-solicitada"
                    className="h-4 w-4 accent-primary"
                    onChange={() => cambiarLetra("A")}
                  />
                  <span>
                    <strong className="block">Factura A</strong>
                    <span className="block text-xs text-muted-foreground">
                      CUIT obligatorio · RI o Monotributo
                    </span>
                  </span>
                </label>
                <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
                  <input
                    type="radio"
                    name="letra-solicitada"
                    value="B"
                    required
                    checked={confirmacion.letraSolicitada === "B"}
                    aria-describedby="ayuda-letra-solicitada"
                    className="h-4 w-4 accent-primary"
                    onChange={() => cambiarLetra("B")}
                  />
                  <span>
                    <strong className="block">Factura B</strong>
                    <span className="block text-xs text-muted-foreground">
                      Identificación opcional · CF o Exento
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          ) : null}

          <ReceptorFiscalForm
            value={receptor}
            favoritos={favoritos}
            clienteComercial={contexto.comprador}
            receptorHeredado={contexto.receptorHeredado}
            letraSolicitada={confirmacion.letraSolicitada}
            confirmaDatosManuales={confirmacion.confirmaDatosManuales}
            estadoConsultaPadron={estadoPadronEfectivo}
            claveConsultaPadron={claveConsultaPadron}
            errores={erroresReceptor}
            disabled={
              emitiendo || previsualizando || (!esNota && confirmacion.letraSolicitada === null)
            }
            onChange={cambiarReceptor}
            onConfirmaDatosManuales={(value) => {
              setErroresReceptor({});
              setConfirmacion((actual) => ({ ...actual, confirmaDatosManuales: value }));
            }}
          />

          {preview ? (
            <ResumenEmisionFiscal
              preview={preview}
              comprador={contexto.comprador.razonSocial}
              requiereSegundaConfirmacion={confirmacion.requiereSegundaConfirmacion}
              asociacionPeriodo={contexto.asociacionPeriodo}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              {esNota
                ? "Revisá el receptor original, la fecha y el importe fiscal."
                : "Elegí la letra y revisá el receptor antes de previsualizar la emisión."}
            </div>
          )}

          {preview?.advertencia_demora && puedeConfirmarVentaAntigua ? (
            <label className="flex min-h-11 items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmaVentaAntigua}
                disabled={emitiendo}
                onChange={(event) => setConfirmaVentaAntigua(event.target.checked)}
              />
              <span>Confirmo emitir esta venta demorada con la fecha fiscal informada.</span>
            </label>
          ) : preview?.advertencia_demora ? (
            <p
              role="alert"
              className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm font-medium text-warning"
            >
              Esta venta demorada sólo puede ser confirmada y emitida por un administrador.
            </p>
          ) : null}

          {esNcPeriodo && preview ? (
            <label className="flex min-h-11 items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm focus-within:ring-2 focus-within:ring-ring">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmaPeriodo}
                disabled={emitiendo}
                onChange={(event) => setConfirmaPeriodo(event.target.checked)}
              />
              <span>
                Confirmo que el período corresponde exactamente a las operaciones ajustadas.
              </span>
            </label>
          ) : null}

          <div aria-live="polite" aria-atomic="true">
            {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
            {emitiendo ? (
              <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Loader2 className="h-4 w-4 animate-spin" /> Emitiendo en ARCA…
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="sticky bottom-0 z-10 border-t border-border bg-background px-4 pb-4 pt-3 shadow-[0_-8px_18px_-16px_hsl(var(--foreground))] sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            disabled={emitiendo}
            onClick={cerrar}
          >
            Cancelar
          </Button>
          {preview ? (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={!puedeEmitir || consultaPadronBloquea || emitiendo}
              onClick={confirmar}
            >
              {emitiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck />}
              {emitiendo
                ? "Emitiendo en ARCA…"
                : confirmacion.requiereSegundaConfirmacion
                  ? "Confirmar cambios y emitir"
                  : "Emitir comprobante"}
            </Button>
          ) : (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={
                previsualizando ||
                emitiendo ||
                consultaPadronBloquea ||
                confirmacion.letraSolicitada === null
              }
              onClick={preparar}
            >
              {previsualizando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {previsualizando ? "Revisando…" : "Revisar datos fiscales"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
