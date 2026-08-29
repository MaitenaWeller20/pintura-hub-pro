import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ArcaRechazoDefinitivo,
  MOCK,
  consultarComprobanteCompleto,
  crearPayloadCaeDesdeSnapshot,
  solicitarCaeConPayload,
  ultimoAutorizado,
  type ComprobanteArcaConsultado,
} from "./arca";
import {
  cbteTipoAfip,
  cbteTipoAfipNcPeriodo,
  condicionIvaReceptorId,
  ivaIdAfip,
  letraDeCbteTipo,
  validarLetraSolicitada,
  type Letra,
  type LetraFacturaSolicitada,
} from "./codigos";
import {
  copiarConfirmacionFiscal,
  crearHuellaConfirmacionFiscal,
  type ConfirmacionFiscalPostBorrador,
} from "./confirmacion";
import { cargarContextoFiscal } from "./contexto.server";
import { validarModalidadFacturaA, type ContextoFiscal } from "./contexto";
import { crearErrorFiscalUsuario } from "./error-usuario";
import {
  type DependenciasEmisionFiscal,
  type EstadoTransicionFiscal,
  type PreparacionEmisionFiscal,
  type ReservaFiscalPersistida,
  type ResultadoEmisionFiscal,
} from "./emision";
import { diasDesdeHoyAr, fechaFiscalHoyAr, validarCorrelatividadFechaFiscal } from "./fecha";
import { decidirConciliacion } from "./reconciliacion";
import { determinarLetraNcPeriodo } from "./nota-credito-periodo";
import {
  resolverReceptorFiscal,
  type FavoritoFiscalRow,
  type VentaParaReceptor,
} from "./receptor.server";
import type { ReceptorFiscalConfirmado, SelectorReceptorFiscal } from "./receptor";
import { consultarPadronArcaDesdeContexto } from "./padron-arca.server";
import type { ReceptorPadronArca } from "./padron-arca-shared";
import {
  crearSnapshotFiscalV3,
  crearSnapshotFiscalV2,
  validarSnapshotFiscalPersistido,
  validarSnapshotFiscalV2,
  type SnapshotFiscalPersistido,
  type SnapshotFiscalV2,
  type SnapshotFiscalV2Input,
  type SnapshotFiscalV3Input,
} from "./snapshot";

const DECIMAL_DOS = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const FECHA_FISCAL = /^\d{4}-\d{2}-\d{2}$/;
const uuid = z.string().uuid();
const decimal = z.string().regex(DECIMAL_DOS);
const fechaFiscal = z.string().regex(FECHA_FISCAL);

const itemExactoSchema = z
  .object({
    id: uuid,
    productoId: uuid.nullable(),
    codigo: z.string().min(1),
    descripcion: z.string().min(1),
    cantidad: decimal,
    precioUnitarioSinIva: decimal,
    descuentoPorcentaje: decimal,
    ivaPorcentaje: decimal,
    subtotalNeto: decimal,
    importeIva: decimal,
    subtotalTotal: decimal,
  })
  .strict();

const clienteExactoSchema = z
  .object({
    id: uuid,
    razonSocial: z.string().min(1),
    cuitDni: z.string().nullable(),
    tipo: z.string().min(1),
    direccion: z.string().nullable(),
  })
  .strict();

const reintegroIntencionExactoSchema = z
  .object({
    id: uuid,
    formaPago: z.enum([
      "EFECTIVO",
      "TRANSFERENCIA",
      "TARJETA_DEBITO",
      "TARJETA_CREDITO",
      "MERCADO_PAGO",
      "CHEQUE",
    ]),
    monto: decimal,
    detalle: z.record(z.string(), z.unknown()),
    orden: z.number().int().nonnegative(),
  })
  .strict();

const ventaExactaSchema = z
  .object({
    id: uuid,
    sucursalId: uuid,
    clienteId: uuid.nullable(),
    cliente: clienteExactoSchema.nullable(),
    fechaComercial: z.string().datetime(),
    numeroComercial: z.string().min(1),
    tipoComprobante: z.string().min(1),
    condicionVenta: z.enum(["CONTADO", "CTA_CTE"]),
    estado: z.string(),
    subtotalSinIva: decimal,
    ivaTotal: decimal,
    percepciones: decimal,
    total: decimal,
    totalPagado: decimal,
    saldo: decimal,
    afipEstado: z.string(),
    afipFase: z.string().nullable(),
    afipClaimToken: uuid.nullable(),
    afipNumero: z.number().int().nullable(),
    afipVersion: z.number().int().nonnegative(),
    afipIntentos: z.number().int().nonnegative(),
    afipEmisorCuit: z.string().nullable(),
    afipPuntoVenta: z.number().int().nullable(),
    afipCbteTipo: z.number().int().nullable(),
    afipModo: z.enum(["PRODUCCION", "HOMOLOGACION"]).nullable(),
    afipSimulado: z.boolean(),
    afipValidez: z.enum(["PRODUCCION", "HOMOLOGACION", "SIMULADA"]).nullable(),
    afipFechaComprobante: z.string().nullable(),
    afipImpTotal: decimal.nullable(),
    afipSnapshot: z.unknown().nullable(),
    afipSnapshotHash: z.string().nullable(),
    afipCbteAsocId: uuid.nullable(),
    periodoAsocDesde: fechaFiscal.nullable(),
    periodoAsocHasta: fechaFiscal.nullable(),
    ncPeriodoModalidad: z.enum(["DEVOLUCION_PRODUCTOS", "BONIFICACION_AJUSTE"]).nullable(),
    motivoNotaCredito: z.string().nullable(),
    ncResolucion: z.enum(["REINTEGRO", "SALDO_FAVOR"]).nullable(),
    ncPeriodoPayloadHash: z.string().nullable(),
    ncEfectosAplicadosAt: z.string().datetime({ offset: true }).nullable(),
    idempotencyKey: uuid.nullable(),
    idempotencyPayloadHash: z.string().nullable(),
    cae: z.string().nullable(),
    caeVencimiento: z.string().nullable(),
  })
  .strict();

const lecturaExactaSchema = z
  .object({
    venta: ventaExactaSchema,
    items: z.array(itemExactoSchema).min(1),
    reintegrosIntencion: z.array(reintegroIntencionExactoSchema),
  })
  .strict();

export type LecturaVentaFiscalExacta = z.infer<typeof lecturaExactaSchema>;
type SupabaseLike = SupabaseClient<Database>;
type RpcFiscalNoGenerada = {
  rpc(
    nombre: "leer_venta_fiscal_exacta",
    argumentos: { p_venta_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  rpc(
    nombre: "transicionar_emision_fiscal",
    argumentos: {
      p_venta_id: string;
      p_accion: string;
      p_claim_token: string | null;
      p_payload: Record<string, unknown>;
    },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/**
 * PostgREST expone la contención determinista de RECLAMAR como 409. El
 * prefijo forma parte del contrato porque PT409 también se usa para una
 * secuencia obsoleta, que debe seguir el camino de recuperación de RESERVAR.
 * 40001 queda aceptado temporalmente para nodos que aún ejecuten la función
 * anterior durante un rollout.
 */
export function esConflictoClaimFiscalServer(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === "40001") return true;
  return (
    value?.code === "PT409" && (value.message ?? "").startsWith("EMISION_FISCAL_VERSION_CONFLICT")
  );
}

export function esConflictoSecuenciaFiscalServer(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return (
    value?.code === "PT409" && (value.message ?? "").startsWith("EMISION_FISCAL_SECUENCIA_OBSOLETA")
  );
}

type PreparacionInterna = {
  lectura: LecturaVentaFiscalExacta;
  contexto: ContextoFiscal;
  direccionSucursal: string;
  receptor: ReceptorFiscalConfirmado;
  letra: Letra;
  original: SnapshotFiscalV2 | null;
  asociacion: import("./emision").AsociacionPreparadaFiscal;
};

export type ItemBorradorFiscal = {
  producto_id: string;
  cantidad: number;
  descuento_porcentaje: number;
  precio_unitario_sin_iva?: number;
};

export type PagoBorradorFiscal = {
  forma_pago:
    | "EFECTIVO"
    | "TRANSFERENCIA"
    | "TARJETA_DEBITO"
    | "TARJETA_CREDITO"
    | "MERCADO_PAGO"
    | "CHEQUE"
    | "CTA_CTE";
  monto: number;
  detalle: Record<string, unknown>;
};

type ProductoBorradorFiscal = {
  id: string;
  activo: boolean;
  precioSinIva: number;
  ivaPorcentaje: number;
};

type ClienteBorradorFiscal = NonNullable<VentaParaReceptor["cliente"]>;

export type DependenciasPreviewBorradorFiscal = {
  cargarContexto(sucursalId: string): Promise<ContextoFiscal>;
  cargarCliente(clienteId: string): Promise<ClienteBorradorFiscal | null>;
  cargarProductos(ids: string[]): Promise<ProductoBorradorFiscal[]>;
  cargarFavorito(id: string): Promise<FavoritoFiscalRow | null>;
  consultarPadron?: (contexto: ContextoFiscal, cuit: string) => Promise<ReceptorPadronArca>;
  ahora(): Date;
};

export type EntradaPreviewBorradorFiscal = {
  sucursalId: string;
  clienteId: string;
  fechaComercial: string;
  items: ItemBorradorFiscal[];
  pagos: PagoBorradorFiscal[];
  percepciones: number;
  receptor: SelectorReceptorFiscal;
  letraSolicitada: LetraFacturaSolicitada;
};

export { crearHuellaConfirmacionFiscal, type ConfirmacionFiscalPostBorrador } from "./confirmacion";

export type LecturasContextoArcaCongelado = {
  cargarEmisor(id: string): Promise<{ id: string; cuit: string | null } | null>;
  cargarCredencial(
    emisorId: string,
    ambiente: "PRODUCCION" | "HOMOLOGACION",
  ): Promise<{
    emisorId: string;
    ambiente: "PRODUCCION" | "HOMOLOGACION";
    arcaKeyEnc: string | null;
    arcaCertEnc: string | null;
  } | null>;
};

/**
 * Después de RESERVAR, la sucursal y su PV vivos dejan de ser autoridad. La
 * credencial se busca por el emisor copiado al Snapshot persistido y se combina sólo
 * con PV/tipo/número/modo de la identidad persistida.
 */
export async function cargarContextoArcaCongelado(
  reserva: ReservaFiscalPersistida,
  lecturas: LecturasContextoArcaCongelado,
) {
  const snapshot = validarSnapshotFiscalPersistido(reserva.snapshot);
  if (
    snapshot.venta.id !== reserva.ventaId ||
    snapshot.hash !== reserva.payloadHash ||
    snapshot.identidad.emisorCuit !== reserva.emisorCuit ||
    snapshot.identidad.puntoVenta !== reserva.puntoVenta ||
    snapshot.identidad.cbteTipo !== reserva.cbteTipo ||
    snapshot.identidad.numero !== reserva.numero ||
    snapshot.identidad.modo !== reserva.modo
  ) {
    throw new Error("La reserva no coincide con la identidad fiscal congelada.");
  }

  const emisor = await lecturas.cargarEmisor(snapshot.emisor.id);
  if (!emisor || emisor.id !== snapshot.emisor.id) {
    throw new Error("No existe el emisor fiscal congelado en el Snapshot.");
  }
  if (emisor.cuit !== snapshot.emisor.cuit || emisor.cuit !== snapshot.identidad.emisorCuit) {
    throw new Error("El CUIT del emisor congelado no coincide con el Snapshot.");
  }

  const credencial = await lecturas.cargarCredencial(emisor.id, snapshot.identidad.modo);
  if (
    !credencial ||
    credencial.emisorId !== emisor.id ||
    credencial.ambiente !== snapshot.identidad.modo ||
    !credencial.arcaKeyEnc ||
    !credencial.arcaCertEnc
  ) {
    throw new Error("Falta la credencial del emisor y ambiente congelados.");
  }

  return {
    emisor: {
      cuit: emisor.cuit,
      arca_key_enc: credencial.arcaKeyEnc,
      arca_cert_enc: credencial.arcaCertEnc,
    },
    pv: { numero: snapshot.identidad.puntoVenta, modo: snapshot.identidad.modo },
    cbteTipo: snapshot.identidad.cbteTipo,
    numero: snapshot.identidad.numero,
  };
}

function centavos(value: string): bigint {
  const [entero, fraccion] = value.split(".");
  return BigInt(entero) * 100n + BigInt(fraccion);
}

function desdeCentavos(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function redondearDosProvisional(value: number): number {
  if (!Number.isFinite(value)) throw new Error("El borrador contiene un importe inválido.");
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function decimalDosProvisional(value: number): string {
  return redondearDosProvisional(value).toFixed(2);
}

function facturaAPermitida(
  letra: Letra,
  contexto: ContextoFiscal,
  ahora: Date = new Date(),
): boolean {
  try {
    validarModalidadFacturaA(
      letra,
      contexto.facturaA.modalidad,
      contexto.facturaA.revalidar_at,
      ahora,
    );
    return true;
  } catch {
    return false;
  }
}

function consultaPadronParaContexto(
  contexto: ContextoFiscal,
  admin: SupabaseLike,
  consultar: typeof consultarPadronArcaDesdeContexto = consultarPadronArcaDesdeContexto,
) {
  if (!contexto.padron.validacionActiva) return undefined;
  return (cuit: string) =>
    consultar({
      cuit,
      emisor: contexto.emisor,
      ambiente: contexto.pv.modo,
      admin,
    });
}

function consultaPadronParaPreview(
  contexto: ContextoFiscal,
  deps: DependenciasPreviewBorradorFiscal,
) {
  if (!contexto.padron.validacionActiva) return undefined;
  if (!deps.consultarPadron) throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
  return (cuit: string) => deps.consultarPadron!(contexto, cuit);
}

/**
 * Preview deliberadamente no autoritativo para una venta todavía inexistente.
 * Replica las reglas visibles de `crear_venta` con catálogo vivo, pero obliga a
 * releer la venta persistida antes de ARCA porque los números del navegador ya
 * atravesaron IEEE-754 y el catálogo puede cambiar entre confirmación/creación.
 */
export async function construirPreviewBorradorFiscalProvisional(
  input: EntradaPreviewBorradorFiscal,
  deps: DependenciasPreviewBorradorFiscal,
) {
  if (input.items.length === 0) throw new Error("El borrador fiscal exige al menos un ítem.");
  const ids = [...new Set(input.items.map((item) => item.producto_id))].sort();
  const [contexto, cliente, productos] = await Promise.all([
    deps.cargarContexto(input.sucursalId),
    deps.cargarCliente(input.clienteId),
    deps.cargarProductos(ids),
  ]);
  if (!cliente) throw new Error("El cliente comercial no está visible para el operador.");

  const catalogo = new Map(productos.map((producto) => [producto.id, producto]));
  if (catalogo.size !== ids.length || ids.some((id) => !catalogo.get(id)?.activo)) {
    throw new Error("Cada producto del borrador debe existir y estar activo.");
  }

  let neto = 0;
  let iva = 0;
  let cantidad = 0;
  for (const item of input.items) {
    const producto = catalogo.get(item.producto_id)!;
    const precio = item.precio_unitario_sin_iva ?? producto.precioSinIva;
    if (
      !Number.isFinite(item.cantidad) ||
      item.cantidad < 0 ||
      !Number.isFinite(item.descuento_porcentaje) ||
      item.descuento_porcentaje < 0 ||
      item.descuento_porcentaje > 100 ||
      !Number.isFinite(precio) ||
      precio < 0 ||
      !Number.isFinite(producto.ivaPorcentaje) ||
      producto.ivaPorcentaje < 0 ||
      producto.ivaPorcentaje > 100
    ) {
      throw new Error("El borrador contiene cantidad, precio, descuento o IVA inválido.");
    }
    cantidad += item.cantidad;
    const netoItem = redondearDosProvisional(
      precio * (1 - item.descuento_porcentaje / 100) * item.cantidad,
    );
    neto += netoItem;
    iva += redondearDosProvisional((netoItem * producto.ivaPorcentaje) / 100);
  }
  if (cantidad <= 0) throw new Error("El borrador exige cantidad total mayor a cero.");
  if (!Number.isFinite(input.percepciones) || input.percepciones < 0) {
    throw new Error("Las percepciones del borrador son inválidas.");
  }
  neto = redondearDosProvisional(neto);
  iva = redondearDosProvisional(iva);
  const percepciones = redondearDosProvisional(input.percepciones);
  const total = redondearDosProvisional(neto + iva + percepciones);
  if (total < 0.01) throw new Error("El total del borrador fiscal debe ser distinto de cero.");

  let sumaPagos = 0;
  for (const pago of input.pagos) {
    if (!Number.isFinite(pago.monto) || pago.monto < 0) {
      throw new Error("El borrador contiene un pago inválido.");
    }
    if (pago.forma_pago === "CTA_CTE") {
      throw new Error("CTA_CTE no es una forma de pago para el preview inmediato.");
    }
    sumaPagos += pago.monto;
  }
  const pagado = redondearDosProvisional(Math.min(sumaPagos, total));
  const saldo = redondearDosProvisional(Math.max(total - pagado, 0));
  const receptor = await resolverReceptorFiscal({
    selector: input.receptor,
    venta: {
      id: "BORRADOR",
      sucursalId: input.sucursalId,
      cliente,
      tipoComprobante: "VENTA",
      comprobanteOriginalId: null,
    },
    importeTotal: total,
    letraSolicitada: input.letraSolicitada,
    cargarFavorito: deps.cargarFavorito,
    cargarOriginal: async () => null,
    consultarPadron: consultaPadronParaPreview(contexto, deps),
  });
  const letra = validarLetraSolicitada(
    contexto.emisor.condicion_iva,
    receptor.condicionIva,
    input.letraSolicitada,
  );
  const ahora = deps.ahora();
  const fechaFiscal = fechaFiscalHoyAr(() => ahora);
  const demoraDias = Math.max(0, diasDesdeHoyAr(new Date(input.fechaComercial), ahora));
  const confirmacionFacturaA = facturaAPermitida(letra, contexto, ahora);
  const totalTexto = decimalDosProvisional(total);
  const confirmacionFingerprint: ConfirmacionFiscalPostBorrador = {
    version: 1,
    importe: totalTexto,
    emisorCuit: contexto.emisor.cuit,
    emisorRazonSocial: contexto.emisorImpreso.razon_social,
    sucursalId: contexto.sucursal.id,
    sucursalNombre: contexto.sucursal.nombre,
    puntoVenta: contexto.pv.numero,
    modo: contexto.pv.modo,
    afipValidez: MOCK ? "SIMULADA" : contexto.pv.modo,
    letra,
    cbteTipo: cbteTipoAfip("VENTA", letra),
    fechaFiscal,
    pagado: decimalDosProvisional(pagado),
    saldo: decimalDosProvisional(saldo),
    cbteAsoc: null,
    receptor,
  };

  return {
    autoritativo: false as const,
    requiere_reconfirmacion_post_creacion: true as const,
    comprador: input.clienteId,
    receptor,
    emisor_cuit: contexto.emisor.cuit,
    emisor_razon_social: contexto.emisorImpreso.razon_social,
    sucursal_id: contexto.sucursal.id,
    sucursal_nombre: contexto.sucursal.nombre,
    punto_venta: contexto.pv.numero,
    modo: contexto.pv.modo,
    afip_validez: MOCK ? "SIMULADA" : contexto.pv.modo,
    letra,
    cbte_tipo: confirmacionFingerprint.cbteTipo,
    cbte_asoc: null,
    razon_letra: `La letra ${letra} fue solicitada y es compatible con la condición ${receptor.condicionIva}.`,
    fecha_comercial: input.fechaComercial,
    fecha_fiscal: fechaFiscal,
    demora_dias: demoraDias,
    advertencia_demora:
      demoraDias > 5
        ? "La venta comercial tendrá más de cinco días; un administrador deberá confirmar la emisión con fecha fiscal actual."
        : null,
    total: totalTexto,
    pagado: decimalDosProvisional(pagado),
    saldo: decimalDosProvisional(saldo),
    confirmacion_factura_a_permitida: confirmacionFacturaA,
    huella_confirmacion: crearHuellaConfirmacionFiscal(confirmacionFingerprint),
    confirmacion_provisional: {
      version: 1 as const,
      importe: totalTexto,
      emisor_cuit: contexto.emisor.cuit,
      emisor_razon_social: contexto.emisorImpreso.razon_social,
      sucursal_id: contexto.sucursal.id,
      sucursal_nombre: contexto.sucursal.nombre,
      punto_venta: contexto.pv.numero,
      modo: contexto.pv.modo,
      afip_validez: confirmacionFingerprint.afipValidez,
      letra,
      cbte_tipo: confirmacionFingerprint.cbteTipo,
      fecha_fiscal: fechaFiscal,
      pagado: confirmacionFingerprint.pagado,
      saldo: confirmacionFingerprint.saldo,
      cbte_asoc: null,
      receptor,
    },
    advertencia:
      "Preview provisional: crear_venta resolverá precios en PostgreSQL y el motor releerá importes exactos antes de ARCA.",
  };
}

function tipoV2(tipo: string): "VENTA" | "NOTA_CREDITO" | "NOTA_DEBITO" {
  if (tipo === "NOTA_CREDITO" || tipo === "NOTA_DEBITO") return tipo;
  if (tipo === "VENTA" || tipo === "FACTURA_A" || tipo === "FACTURA_B") return "VENTA";
  throw new Error(`${tipo} no es un comprobante fiscal emitible por el motor v2.`);
}

function alicuotasDesdeItems(items: LecturaVentaFiscalExacta["items"]) {
  const grupos = new Map<number, { base: bigint; importe: bigint }>();
  for (const item of items) {
    const id = ivaIdAfip(Number(item.ivaPorcentaje));
    const actual = grupos.get(id) ?? { base: 0n, importe: 0n };
    actual.base += centavos(item.subtotalNeto);
    actual.importe += centavos(item.importeIva);
    grupos.set(id, actual);
  }
  return [...grupos.entries()]
    .filter(([, row]) => row.base !== 0n || row.importe !== 0n)
    .sort(([a], [b]) => a - b)
    .map(([id, row]) => ({
      id,
      baseImponible: desdeCentavos(row.base),
      importe: desdeCentavos(row.importe),
    }));
}

function tributosDesdeLectura(lectura: LecturaVentaFiscalExacta) {
  if (centavos(lectura.venta.percepciones) === 0n) return [];
  return [
    {
      id: 99,
      descripcion: "Percepciones",
      baseImponible: lectura.venta.subtotalSinIva,
      alicuota: "0.00",
      importe: lectura.venta.percepciones,
    },
  ];
}

function camposVenta(lectura: LecturaVentaFiscalExacta) {
  return {
    id: lectura.venta.id,
    numeroComercial: lectura.venta.numeroComercial,
    tipoComprobante: tipoV2(lectura.venta.tipoComprobante) as "VENTA" | "NOTA_CREDITO",
    condicionVenta: lectura.venta.condicionVenta,
    fechaComercial: lectura.venta.fechaComercial,
  };
}

export function construirSnapshotFiscalDesdeLectura(input: {
  preparacion: PreparacionInterna;
  numero: number;
  fechaComprobante: string;
}): SnapshotFiscalPersistido {
  const { preparacion, numero, fechaComprobante } = input;
  const { lectura, contexto, receptor, letra, original } = preparacion;
  const tipo = tipoV2(lectura.venta.tipoComprobante);
  if (tipo === "NOTA_DEBITO") throw new Error("La nota de débito nueva queda fuera de alcance.");

  if (tipo === "NOTA_CREDITO" && preparacion.asociacion.tipo === "COMPROBANTE") {
    if (!original || !lectura.venta.afipCbteAsocId) {
      throw new Error("La nota de crédito exige el Snapshot v2 original.");
    }
    const { hash: _hash, version: _version, ...cuerpoOriginal } = original;
    return crearSnapshotFiscalV2({
      ...cuerpoOriginal,
      venta: camposVenta(lectura),
      identidad: {
        ...original.identidad,
        numero,
        cbteTipo: cbteTipoAfip("NOTA_CREDITO", original.letra),
      },
      fechaComprobante,
      origen: "COMPROBANTE_ORIGINAL",
      comprobanteOriginalId: lectura.venta.afipCbteAsocId,
      cbtesAsoc: [
        {
          tipo: original.identidad.cbteTipo,
          puntoVenta: original.identidad.puntoVenta,
          numero: original.identidad.numero,
          cuit: original.identidad.emisorCuit,
          fecha: original.fechaComprobante,
        },
      ],
    } as SnapshotFiscalV2Input);
  }

  const emisor = {
    id: contexto.sucursal.emisor_id,
    razonSocial: contexto.emisorImpreso.razon_social,
    nombreFantasia: contexto.emisorImpreso.nombre_fantasia,
    cuit: contexto.emisorImpreso.cuit,
    domicilioFiscal: contexto.emisorImpreso.domicilio_fiscal ?? "",
    condicionIva: contexto.emisorImpreso.condicion_iva,
    ingresosBrutos: contexto.emisorImpreso.ingresos_brutos,
    inicioActividades: contexto.emisorImpreso.inicio_actividades,
    telefono: contexto.emisorImpreso.telefono,
  };
  const sucursal = {
    id: contexto.sucursal.id,
    nombre: contexto.sucursal.nombre,
    direccion: preparacion.direccionSucursal,
    telefono: contexto.sucursal.telefono,
  };
  const receptorSnapshot = {
    ...receptor,
    condicionIvaReceptorId: condicionIvaReceptorId(receptor.condicionIva) as 1 | 4 | 5 | 6,
  };
  const items = lectura.items.map((item) => ({ ...item }));

  if (tipo === "NOTA_CREDITO" && preparacion.asociacion.tipo === "PERIODO") {
    return crearSnapshotFiscalV3({
      venta: camposVenta(lectura),
      items,
      emisor,
      sucursal,
      receptor: receptorSnapshot,
      identidad: {
        numero,
        emisorCuit: contexto.emisor.cuit,
        puntoVenta: contexto.pv.numero,
        cbteTipo: cbteTipoAfipNcPeriodo(letra),
        modo: contexto.pv.modo,
        simulado: MOCK,
        validez: MOCK ? "SIMULADA" : contexto.pv.modo,
      },
      letra,
      concepto: 1,
      fechaComprobante,
      importeNeto: lectura.venta.subtotalSinIva,
      importeExento: "0.00",
      importeNoGravado: "0.00",
      importeIva: lectura.venta.ivaTotal,
      importeTributos: "0.00",
      importeTotal: lectura.venta.total,
      alicuotasIva: alicuotasDesdeItems(lectura.items),
      tributos: [],
      moneda: "PES",
      cotizacion: "1.000000",
      ivaContenido:
        letra === "B" && receptor.condicionIva === "CONSUMIDOR_FINAL"
          ? lectura.venta.ivaTotal
          : "0.00",
      otrosImpuestosNacionalesIndirectos: "0.00",
      periodoAsoc: {
        desde: preparacion.asociacion.desde,
        hasta: preparacion.asociacion.hasta,
      },
      notaCredito: {
        modalidad: preparacion.asociacion.modalidad,
        motivo: preparacion.asociacion.motivo,
      },
    } as SnapshotFiscalV3Input);
  }

  if (tipo === "NOTA_CREDITO") {
    throw new Error("Una nota fiscal requiere exactamente una asociación preparada.");
  }

  const tributos = tributosDesdeLectura(lectura);
  return crearSnapshotFiscalV2({
    venta: camposVenta(lectura),
    items,
    emisor,
    sucursal,
    receptor: receptorSnapshot,
    identidad: {
      numero,
      emisorCuit: contexto.emisor.cuit,
      puntoVenta: contexto.pv.numero,
      cbteTipo: cbteTipoAfip("VENTA", letra),
      modo: contexto.pv.modo,
      simulado: MOCK,
      validez: MOCK ? "SIMULADA" : contexto.pv.modo,
    },
    letra,
    concepto: 1,
    fechaComprobante,
    importeNeto: lectura.venta.subtotalSinIva,
    importeExento: "0.00",
    importeNoGravado: "0.00",
    importeIva: lectura.venta.ivaTotal,
    importeTributos: lectura.venta.percepciones,
    importeTotal: lectura.venta.total,
    alicuotasIva: alicuotasDesdeItems(lectura.items),
    tributos,
    moneda: "PES",
    cotizacion: "1.000000",
    ivaContenido:
      letra === "B" && receptor.condicionIva === "CONSUMIDOR_FINAL"
        ? lectura.venta.ivaTotal
        : "0.00",
    // `percepciones` es un tributo genérico del modelo comercial. No alcanza
    // para afirmar que sea un Impuesto Nacional Indirecto de la Ley 27.743.
    // Hasta contar con una fuente específica y trazable, el importe legal es 0.
    otrosImpuestosNacionalesIndirectos: "0.00",
    origen: "VENTA",
    comprobanteOriginalId: null,
    cbtesAsoc: [],
  });
}

async function leerVentaExacta(
  admin: SupabaseLike,
  ventaId: string,
): Promise<LecturaVentaFiscalExacta> {
  const { data, error } = await (admin as unknown as RpcFiscalNoGenerada).rpc(
    "leer_venta_fiscal_exacta",
    {
      p_venta_id: ventaId,
    },
  );
  if (error) throw new Error(`No se pudo leer la venta fiscal exacta: ${error.message}.`);
  return lecturaExactaSchema.parse(data);
}

async function cargarCliente(usuario: SupabaseLike, clienteId: string | null) {
  if (!clienteId) return null;
  const { data, error } = await usuario
    .from("clientes")
    .select("id,razon_social,cuit_dni,tipo,direccion")
    .eq("id", clienteId)
    .maybeSingle();
  if (error || !data) throw new Error("El cliente comercial no está visible para el operador.");
  return {
    id: data.id,
    razonSocial: data.razon_social,
    cuitDni: data.cuit_dni,
    tipo: data.tipo,
    direccion: data.direccion,
  };
}

async function cargarFavorito(usuario: SupabaseLike, id: string) {
  const { data, error } = await usuario
    .from("receptores_fiscales")
    .select(
      "id,sucursal_id,activo,tipo_documento,numero_documento,razon_social,condicion_iva,domicilio",
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    sucursalId: data.sucursal_id,
    activo: data.activo,
    tipoDocumento: data.tipo_documento,
    numeroDocumento: data.numero_documento,
    razonSocial: data.razon_social,
    condicionIva: data.condicion_iva,
    domicilio: data.domicilio,
  } as never;
}

function estadoDesdeRpc(data: unknown): EstadoTransicionFiscal {
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object")
    throw new Error("La transición fiscal no devolvió una fila.");
  const value = row as Record<string, unknown>;
  if (
    typeof value.venta_id !== "string" ||
    typeof value.afip_estado !== "string" ||
    (value.afip_fase !== null && typeof value.afip_fase !== "string") ||
    (value.afip_claim_token !== null && typeof value.afip_claim_token !== "string") ||
    (value.afip_numero !== null && typeof value.afip_numero !== "number") ||
    typeof value.afip_version !== "number"
  ) {
    throw new Error("La transición fiscal devolvió tipos inválidos.");
  }
  return value as EstadoTransicionFiscal;
}

async function direccionSucursal(admin: SupabaseLike, sucursalId: string): Promise<string> {
  const { data, error } = await admin
    .from("sucursales")
    .select("direccion")
    .eq("id", sucursalId)
    .maybeSingle();
  if (error || !data?.direccion)
    throw new Error("La sucursal no tiene domicilio fiscal imprimible.");
  return data.direccion;
}

export async function observarUltimoNumeroFiscalLocal(
  admin: SupabaseLike,
  identidad: Pick<
    PreparacionEmisionFiscal,
    "emisorCuit" | "puntoVenta" | "cbteTipo" | "modo" | "simulado"
  >,
): Promise<number> {
  const { data, error } = await admin
    .from("ventas")
    .select("afip_numero")
    .eq("afip_emisor_cuit", identidad.emisorCuit)
    .eq("afip_punto_venta", identidad.puntoVenta)
    .eq("afip_cbte_tipo", identidad.cbteTipo)
    .eq("afip_modo", identidad.modo)
    .eq("afip_simulado", identidad.simulado)
    .not("afip_numero", "is", null)
    .order("afip_numero", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo observar la secuencia local: ${error.message}.`);
  return Number(data?.afip_numero ?? 0);
}

export type CrearDependenciasEmisionFiscalServerInput = {
  admin: SupabaseLike;
  usuario: SupabaseLike;
  ventaIdAutorizada: string;
  validarModalidadFacturaA?: boolean;
  consultarPadron?: typeof consultarPadronArcaDesdeContexto;
};

export function crearDependenciasEmisionFiscalServer(
  input: CrearDependenciasEmisionFiscalServerInput,
): DependenciasEmisionFiscal & {
  obtenerVistaPreparacion(ventaId: string): {
    receptor: ReceptorFiscalConfirmado;
    letra: Letra;
    contexto: ContextoFiscal;
    original: SnapshotFiscalV2 | null;
  };
} {
  const { admin, usuario, ventaIdAutorizada } = input;
  const preparaciones = new Map<string, PreparacionInterna>();

  async function contextoParaVenta(ventaId: string) {
    const lectura = await leerVentaExacta(admin, ventaId);
    const contexto = await cargarContextoFiscal(admin, lectura.venta.sucursalId);
    return { lectura, contexto };
  }

  async function cargarOriginal(id: string) {
    const lectura = await leerVentaExacta(admin, id);
    return {
      id,
      estado: lectura.venta.afipEstado,
      fase: lectura.venta.afipFase,
      snapshot: lectura.venta.afipSnapshot,
    };
  }

  async function prepararAsociacion(
    lectura: LecturaVentaFiscalExacta,
  ): Promise<import("./emision").AsociacionPreparadaFiscal> {
    const venta = lectura.venta;
    const camposPeriodo = [
      venta.periodoAsocDesde,
      venta.periodoAsocHasta,
      venta.ncPeriodoModalidad,
      venta.motivoNotaCredito,
      venta.ncResolucion,
      venta.ncPeriodoPayloadHash,
    ];
    const tieneAlgunCampoPeriodo = camposPeriodo.some((campo) => campo !== null);
    const tienePeriodoCompleto = camposPeriodo.every((campo) => campo !== null);
    if (venta.afipCbteAsocId && tieneAlgunCampoPeriodo) {
      throw new Error("La venta fiscal contiene ambas asociaciones.");
    }
    if (venta.afipCbteAsocId) {
      const originalRow = await cargarOriginal(venta.afipCbteAsocId);
      if (originalRow.estado !== "APROBADO" || originalRow.fase !== "PERSISTIDO") {
        throw new Error("El comprobante original debe estar APROBADO/PERSISTIDO.");
      }
      return { tipo: "COMPROBANTE", original: validarSnapshotFiscalV2(originalRow.snapshot) };
    }
    if (tieneAlgunCampoPeriodo) {
      if (!tienePeriodoCompleto) throw new Error("La asociación por período está incompleta.");
      if (venta.tipoComprobante !== "NOTA_CREDITO") {
        throw new Error("Sólo una nota de crédito puede asociarse por período.");
      }
      if (venta.ncEfectosAplicadosAt !== null) {
        throw new Error("La nota por período ya tiene efectos comerciales aplicados.");
      }
      return {
        tipo: "PERIODO",
        desde: venta.periodoAsocDesde!,
        hasta: venta.periodoAsocHasta!,
        modalidad: venta.ncPeriodoModalidad!,
        motivo: venta.motivoNotaCredito!,
        resolucion: venta.ncResolucion!,
      };
    }
    return { tipo: "NINGUNA" };
  }

  async function contextoReserva(reserva: ReservaFiscalPersistida) {
    return cargarContextoArcaCongelado(reserva, {
      async cargarEmisor(id) {
        const { data, error } = await admin
          .from("emisores")
          .select("id,cuit")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(`No se pudo cargar el emisor congelado: ${error.message}.`);
        return data ? { id: data.id, cuit: data.cuit } : null;
      },
      async cargarCredencial(emisorId, ambiente) {
        const { data, error } = await admin
          .from("credenciales_arca")
          .select("emisor_id,ambiente,arca_key_enc,arca_cert_enc")
          .eq("emisor_id", emisorId)
          .eq("ambiente", ambiente)
          .maybeSingle();
        if (error) throw new Error(`No se pudo cargar la credencial congelada: ${error.message}.`);
        if (!data) return null;
        if (data.ambiente !== "PRODUCCION" && data.ambiente !== "HOMOLOGACION") {
          throw new Error("La credencial congelada tiene un ambiente inválido.");
        }
        return {
          emisorId: data.emisor_id,
          ambiente: data.ambiente,
          arcaKeyEnc: data.arca_key_enc,
          arcaCertEnc: data.arca_cert_enc,
        };
      },
    });
  }

  return {
    obtenerVistaPreparacion(ventaId) {
      const interna = preparaciones.get(ventaId);
      if (!interna) throw new Error("No existe una previsualización fiscal preparada.");
      return {
        receptor: { ...interna.receptor },
        letra: interna.letra,
        contexto: interna.contexto,
        original: interna.original,
      };
    },
    generarClaimToken: () => crypto.randomUUID(),
    ahoraIso: () => new Date().toISOString(),
    async autorizarEmision({ ventaId }) {
      if (ventaId !== ventaIdAutorizada)
        throw new Error("Venta fiscal fuera de la autorización previa.");
      const lectura = await leerVentaExacta(admin, ventaId);
      return {
        tipoComprobante: tipoV2(lectura.venta.tipoComprobante),
        afipVersion: lectura.venta.afipVersion,
        asociacion: await prepararAsociacion(lectura),
      };
    },
    async autorizarConciliacion({ ventaId }) {
      if (ventaId !== ventaIdAutorizada)
        throw new Error("Venta fiscal fuera de la autorización previa.");
    },
    async prepararEmision({ ventaId, receptor: selector, seleccionLetra }) {
      const { lectura, contexto } = await contextoParaVenta(ventaId);
      if (lectura.venta.cae) throw new Error("La venta ya tiene CAE.");
      const tipo = tipoV2(lectura.venta.tipoComprobante);
      if (tipo === "NOTA_DEBITO")
        throw new Error("Las notas de débito nuevas no están habilitadas.");
      const asociacion = await prepararAsociacion(lectura);
      if (tipo === "VENTA" && asociacion.tipo !== "NINGUNA") {
        throw new Error("Una venta ordinaria no admite asociación fiscal.");
      }
      if (tipo === "NOTA_CREDITO" && asociacion.tipo === "NINGUNA") {
        throw new Error("Una nota fiscal requiere exactamente una asociación.");
      }
      if (asociacion.tipo === "PERIODO" && seleccionLetra.origen !== "AUTOMATICA_NC_PERIODO") {
        throw new Error("La letra de una nota por período se determina automáticamente.");
      }
      if (asociacion.tipo !== "PERIODO" && seleccionLetra.origen !== "EXPLICITA") {
        throw new Error("El flujo v2 exige letra A o B explícita.");
      }
      const letraExplicita = seleccionLetra.origen === "EXPLICITA" ? seleccionLetra.letra : null;
      const ventaReceptor: VentaParaReceptor = {
        id: lectura.venta.id,
        sucursalId: lectura.venta.sucursalId,
        cliente: lectura.venta.cliente,
        tipoComprobante: tipo,
        comprobanteOriginalId: lectura.venta.afipCbteAsocId,
        asociacion,
      };
      const receptorConfirmado = await resolverReceptorFiscal({
        selector,
        venta: ventaReceptor,
        importeTotal: Number(lectura.venta.total),
        letraSolicitada: asociacion.tipo === "PERIODO" ? null : letraExplicita!,
        cargarFavorito: (id) => cargarFavorito(usuario, id),
        cargarOriginal,
        consultarPadron: consultaPadronParaContexto(contexto, admin, input.consultarPadron),
      });
      const original = asociacion.tipo === "COMPROBANTE" ? asociacion.original : null;
      if (
        original &&
        (contexto.emisor.cuit !== original.identidad.emisorCuit ||
          contexto.pv.modo !== original.identidad.modo)
      ) {
        throw new Error("El emisor o ambiente actual no permite operar la identidad del original.");
      }
      const letra = original
        ? original.letra
        : asociacion.tipo === "PERIODO"
          ? determinarLetraNcPeriodo(contexto.emisor.condicion_iva, receptorConfirmado.condicionIva)
          : validarLetraSolicitada(
              contexto.emisor.condicion_iva,
              receptorConfirmado.condicionIva,
              letraExplicita!,
            );
      if (input.validarModalidadFacturaA !== false) {
        validarModalidadFacturaA(
          letra,
          contexto.facturaA.modalidad,
          contexto.facturaA.revalidar_at,
        );
      }
      const fechaComprobante = fechaFiscalHoyAr();
      const interna: PreparacionInterna = {
        lectura,
        contexto,
        direccionSucursal: await direccionSucursal(admin, lectura.venta.sucursalId),
        receptor: receptorConfirmado,
        letra,
        original,
        asociacion,
      };
      preparaciones.set(ventaId, interna);
      const cbteAsoc = original
        ? {
            tipo: original.identidad.cbteTipo,
            letra: original.letra,
            puntoVenta: original.identidad.puntoVenta,
            numero: original.identidad.numero,
            fecha: original.fechaComprobante,
          }
        : null;
      const preparacionBase = {
        ventaId,
        tipoComprobante: tipo,
        emisorCuit: original?.identidad.emisorCuit ?? contexto.emisor.cuit,
        puntoVenta: original?.identidad.puntoVenta ?? contexto.pv.numero,
        cbteTipo:
          asociacion.tipo === "PERIODO"
            ? cbteTipoAfipNcPeriodo(letra)
            : cbteTipoAfip(tipo, original?.letra ?? letra),
        modo: original?.identidad.modo ?? contexto.pv.modo,
        simulado: original?.identidad.simulado ?? MOCK,
        validez: original?.identidad.validez ?? (MOCK ? "SIMULADA" : contexto.pv.modo),
        fechaComprobante,
        reconfirmacion: {
          fechaComercial: lectura.venta.fechaComercial,
          pagado: lectura.venta.totalPagado,
          saldo: lectura.venta.saldo,
          comprador: lectura.venta.clienteId,
          cbteAsoc,
          demoraDias: diasDesdeHoyAr(new Date(lectura.venta.fechaComercial)),
          advertenciaDemora:
            diasDesdeHoyAr(new Date(lectura.venta.fechaComercial)) > 5
              ? "La venta comercial tiene más de cinco días; un administrador debe confirmar la emisión con fecha fiscal actual."
              : null,
          confirmacionFacturaAPermitida: facturaAPermitida(letra, contexto),
        },
      };
      const confirmacionAutoritativa: ConfirmacionFiscalPostBorrador = {
        version: 1,
        importe: lectura.venta.total,
        emisorCuit: preparacionBase.emisorCuit,
        emisorRazonSocial: original?.emisor.razonSocial ?? contexto.emisorImpreso.razon_social,
        sucursalId: original?.sucursal.id ?? contexto.sucursal.id,
        sucursalNombre: original?.sucursal.nombre ?? contexto.sucursal.nombre,
        puntoVenta: preparacionBase.puntoVenta,
        modo: preparacionBase.modo,
        afipValidez: preparacionBase.validez,
        letra,
        cbteTipo: preparacionBase.cbteTipo,
        fechaFiscal: fechaComprobante,
        pagado: lectura.venta.totalPagado,
        saldo: lectura.venta.saldo,
        cbteAsoc,
        receptor: proyectarReceptorFiscalConfirmado(receptorConfirmado),
      };
      return {
        ...preparacionBase,
        asociacion,
        confirmacionAutoritativa,
        huellaConfirmacion: crearHuellaConfirmacionFiscal(confirmacionAutoritativa),
      };
    },
    async consultarSecuencia(preparacion: PreparacionEmisionFiscal) {
      const interna = preparaciones.get(preparacion.ventaId);
      if (!interna) throw new Error("No existe una preparación fiscal vigente.");
      const { contexto } = interna;
      const ultimoRemoto = await ultimoAutorizado(
        contexto.emisor,
        { numero: preparacion.puntoVenta, modo: preparacion.modo },
        preparacion.cbteTipo,
        admin,
      );
      let ultimaFechaRemota: string | null = null;
      if (ultimoRemoto > 0) {
        const ultimo = await consultarComprobanteCompleto(
          contexto.emisor,
          { numero: preparacion.puntoVenta, modo: preparacion.modo },
          preparacion.cbteTipo,
          ultimoRemoto,
          admin,
        );
        if (!ultimo) throw new Error("ARCA omitió el último comprobante que informó autorizado.");
        ultimaFechaRemota = ultimo.fecha;
      }
      return {
        ultimoRemoto,
        ultimaFechaRemota,
        ultimoLocal: await observarUltimoNumeroFiscalLocal(admin, preparacion),
      };
    },
    validarFechaFiscal: (fecha, ultima) => validarCorrelatividadFechaFiscal(fecha, ultima),
    async crearSnapshot({ preparacion, numero }) {
      const interna = preparaciones.get(preparacion.ventaId);
      if (!interna) throw new Error("No existe una preparación fiscal vigente.");
      return construirSnapshotFiscalDesdeLectura({
        preparacion: interna,
        numero,
        fechaComprobante: preparacion.fechaComprobante,
      });
    },
    async transicionar({ ventaId, accion, claimToken, payload }) {
      const { data, error } = await (admin as unknown as RpcFiscalNoGenerada).rpc(
        "transicionar_emision_fiscal",
        {
          p_venta_id: ventaId,
          p_accion: accion,
          p_claim_token: claimToken,
          p_payload: payload,
        },
      );
      if (error) {
        const fallo = new Error(error.message) as Error & { code?: string };
        fallo.code = error.code;
        throw fallo;
      }
      return estadoDesdeRpc(data);
    },
    async cargarEstadoPersistido(ventaId) {
      const lectura = await leerVentaExacta(admin, ventaId);
      return {
        venta_id: lectura.venta.id,
        afip_estado: lectura.venta.afipEstado,
        afip_fase: lectura.venta.afipFase,
        afip_claim_token: lectura.venta.afipClaimToken,
        afip_numero: lectura.venta.afipNumero,
        afip_version: lectura.venta.afipVersion,
      };
    },
    async cargarReservaPersistida(ventaId) {
      const lectura = await leerVentaExacta(admin, ventaId);
      const snapshot = validarSnapshotFiscalPersistido(lectura.venta.afipSnapshot);
      if (
        !lectura.venta.afipClaimToken ||
        lectura.venta.afipNumero == null ||
        !lectura.venta.afipSnapshotHash ||
        !lectura.venta.afipEmisorCuit ||
        lectura.venta.afipPuntoVenta == null ||
        lectura.venta.afipCbteTipo == null ||
        !lectura.venta.afipModo
      ) {
        throw new Error("La reserva fiscal persistida está incompleta.");
      }
      return {
        ventaId,
        claimToken: lectura.venta.afipClaimToken,
        afipVersion: lectura.venta.afipVersion,
        numero: lectura.venta.afipNumero,
        snapshot,
        payloadHash: lectura.venta.afipSnapshotHash,
        emisorCuit: lectura.venta.afipEmisorCuit,
        puntoVenta: lectura.venta.afipPuntoVenta,
        cbteTipo: lectura.venta.afipCbteTipo,
        modo: lectura.venta.afipModo,
      };
    },
    async cargarEstadoParaLiberar(ventaId) {
      const lectura = await leerVentaExacta(admin, ventaId);
      if (!lectura.venta.afipClaimToken) {
        throw new Error("La venta no tiene claim fiscal vigente para liberar.");
      }
      const tieneIdentidadReservada =
        lectura.venta.afipNumero !== null ||
        lectura.venta.afipEmisorCuit !== null ||
        lectura.venta.afipPuntoVenta !== null ||
        lectura.venta.afipCbteTipo !== null ||
        lectura.venta.afipModo !== null ||
        lectura.venta.afipSimulado ||
        lectura.venta.afipValidez !== null ||
        lectura.venta.afipFechaComprobante !== null ||
        lectura.venta.afipImpTotal !== null ||
        lectura.venta.afipSnapshot !== null ||
        lectura.venta.afipSnapshotHash !== null ||
        lectura.venta.cae !== null ||
        lectura.venta.caeVencimiento !== null;
      return {
        claimToken: lectura.venta.afipClaimToken,
        afipVersion: lectura.venta.afipVersion,
        afipEstado: lectura.venta.afipEstado,
        afipFase: lectura.venta.afipFase,
        afipNumero: lectura.venta.afipNumero,
        tieneIdentidadReservada,
      };
    },
    crearPayloadCae: crearPayloadCaeDesdeSnapshot,
    async solicitarCae(reserva, payload) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("El payload CAE derivado del Snapshot no es un objeto.");
      }
      const contexto = await contextoReserva(reserva);
      try {
        const respuesta = await solicitarCaeConPayload(
          contexto.emisor,
          contexto.pv,
          payload as Record<string, unknown>,
          contexto.numero,
          admin,
        );
        return {
          resultado: "APROBADA" as const,
          cae: respuesta.cae,
          vencimiento: respuesta.vencimiento?.toISOString().slice(0, 10) ?? null,
        };
      } catch (error) {
        if (error instanceof ArcaRechazoDefinitivo) {
          return {
            resultado: "RECHAZADA" as const,
            codigo: error.codigo,
            mensajeMascarado: error.message,
          };
        }
        throw error;
      }
    },
    esConflictoClaim(error) {
      return esConflictoClaimFiscalServer(error);
    },
    esConflictoSecuencia(error) {
      return esConflictoSecuenciaFiscalServer(error);
    },
    async consultarComprobanteCompleto(reserva) {
      const contexto = await contextoReserva(reserva);
      return consultarComprobanteCompleto(
        contexto.emisor,
        contexto.pv,
        contexto.cbteTipo,
        contexto.numero,
        admin,
      );
    },
    async consultarUltimoAutorizado(reserva) {
      const contexto = await contextoReserva(reserva);
      return ultimoAutorizado(contexto.emisor, contexto.pv, contexto.cbteTipo, admin);
    },
    decidirConciliacion({ snapshot, remoto, ultimoRemoto, numeroReservado, payloadHash }) {
      return decidirConciliacion({
        snapshot,
        remoto: remoto as ComprobanteArcaConsultado | null,
        ultimoRemoto,
        numeroReservado,
        payloadHash,
      });
    },
    async guardarFavoritoConfirmado({ receptor }) {
      const preparado = preparaciones.get(ventaIdAutorizada);
      if (!preparado) throw new Error("No existe receptor confirmado para guardar.");
      const confirmado = preparado.receptor;
      if (
        receptor.origen !== "MANUAL" ||
        (confirmado.origen !== "MANUAL" &&
          !(confirmado.origen === "ARCA" && confirmado.origenId === null))
      ) {
        throw new Error("Sólo un receptor manual confirmado se guarda como favorito.");
      }
      const creador = (await usuario.auth.getUser()).data.user?.id;
      if (!creador || !confirmado.numeroDocumento) {
        throw new Error("El favorito exige usuario y documento fiscal confirmados.");
      }
      const { error } = await usuario.from("receptores_fiscales").insert({
        sucursal_id: preparado.lectura.venta.sucursalId,
        creado_por: creador,
        cliente_comercial_id: preparado.lectura.venta.clienteId,
        tipo_documento: confirmado.tipoDocumento,
        numero_documento: confirmado.numeroDocumento,
        razon_social: confirmado.razonSocial,
        condicion_iva: confirmado.condicionIva,
        domicilio: confirmado.domicilio,
      });
      if (error) throw new Error(`No se pudo guardar el favorito fiscal: ${error.message}.`);
    },
  };
}

export async function liberarClaimFiscalVerificado(input: {
  ventaId: string;
  deps: DependenciasEmisionFiscal;
}): Promise<{ estado: "LIBERADO" }> {
  if (!input.deps.cargarEstadoParaLiberar) {
    throw new Error("LIBERAR exige una lectura segura del estado PREFLIGHT.");
  }
  const estado = await input.deps.cargarEstadoParaLiberar(input.ventaId);
  if (
    estado.afipEstado !== "EMITIENDO" ||
    estado.afipFase !== "PREFLIGHT" ||
    estado.afipNumero !== null ||
    estado.tieneIdentidadReservada
  ) {
    throw new Error("LIBERAR sólo admite un claim PREFLIGHT vencido sin identidad reservada.");
  }
  await input.deps.transicionar({
    ventaId: input.ventaId,
    accion: "LIBERAR",
    claimToken: estado.claimToken,
    payload: {
      expected_version: estado.afipVersion,
      verificacion: { nunca_enviado: true, fuente: "log_intento" },
    },
  });
  return { estado: "LIBERADO" };
}

/**
 * El snapshot necesita el id numérico de condición IVA para ARCA, pero el
 * contrato público del selector confirma sólo datos del receptor. Proyectar
 * campo por campo evita que una NC herede y filtre metadata interna.
 */
export function proyectarReceptorFiscalConfirmado(
  receptor: ReceptorFiscalConfirmado & { condicionIvaReceptorId?: unknown },
): ReceptorFiscalConfirmado {
  return {
    razonSocial: receptor.razonSocial,
    domicilio: receptor.domicilio,
    tipoDocumento: receptor.tipoDocumento,
    numeroDocumento: receptor.numeroDocumento,
    docTipoArca: receptor.docTipoArca,
    docNroArca: receptor.docNroArca,
    condicionIva: receptor.condicionIva,
    origen: receptor.origen,
    origenId: receptor.origenId,
    verificadoArcaAt: receptor.verificadoArcaAt,
  };
}

export async function previsualizarVentaFiscalExistente(input: {
  ventaId: string;
  receptor: SelectorReceptorFiscal;
  letraSolicitada: LetraFacturaSolicitada;
  admin: SupabaseLike;
  usuario: SupabaseLike;
  consultarPadron?: typeof consultarPadronArcaDesdeContexto;
}) {
  const deps = crearDependenciasEmisionFiscalServer({
    admin: input.admin,
    usuario: input.usuario,
    ventaIdAutorizada: input.ventaId,
    validarModalidadFacturaA: false,
    consultarPadron: input.consultarPadron,
  });
  const preparacion = await deps.prepararEmision({
    ventaId: input.ventaId,
    receptor: input.receptor,
    seleccionLetra: { origen: "EXPLICITA", letra: input.letraSolicitada },
  });
  const lectura = await leerVentaExacta(input.admin, input.ventaId);
  const vista = deps.obtenerVistaPreparacion(input.ventaId);
  const receptorVisible = proyectarReceptorFiscalConfirmado(vista.receptor);
  const demoraDias = diasDesdeHoyAr(new Date(lectura.venta.fechaComercial));
  const emisorRazonSocial =
    vista.original?.emisor.razonSocial ?? vista.contexto.emisorImpreso.razon_social;
  const sucursalId = vista.original?.sucursal.id ?? vista.contexto.sucursal.id;
  const sucursalNombre = vista.original?.sucursal.nombre ?? vista.contexto.sucursal.nombre;
  const cbteAsoc = vista.original
    ? {
        tipo: vista.original.identidad.cbteTipo,
        letra: vista.original.letra,
        puntoVenta: vista.original.identidad.puntoVenta,
        numero: vista.original.identidad.numero,
        fecha: vista.original.fechaComprobante,
      }
    : null;
  const confirmacionAutoritativa: ConfirmacionFiscalPostBorrador = {
    version: 1,
    importe: lectura.venta.total,
    emisorCuit: preparacion.emisorCuit,
    emisorRazonSocial,
    sucursalId,
    sucursalNombre,
    puntoVenta: preparacion.puntoVenta,
    modo: preparacion.modo,
    afipValidez: preparacion.validez,
    letra: vista.letra,
    cbteTipo: preparacion.cbteTipo,
    fechaFiscal: preparacion.fechaComprobante,
    pagado: lectura.venta.totalPagado,
    saldo: lectura.venta.saldo,
    cbteAsoc,
    receptor: receptorVisible,
  };
  return {
    autoritativo: true,
    venta_id: input.ventaId,
    fecha_comercial: lectura.venta.fechaComercial,
    fecha_fiscal: preparacion.fechaComprobante,
    total: lectura.venta.total,
    pagado: lectura.venta.totalPagado,
    saldo: lectura.venta.saldo,
    comprador: lectura.venta.clienteId,
    receptor: receptorVisible,
    letra: vista.letra,
    razon_letra: vista.original
      ? `La nota hereda la letra ${vista.letra} del comprobante original.`
      : `La letra ${vista.letra} fue solicitada y es compatible con la condición ${vista.receptor.condicionIva}.`,
    emisor_cuit: preparacion.emisorCuit,
    emisor_razon_social: emisorRazonSocial,
    sucursal_id: sucursalId,
    sucursal_nombre: sucursalNombre,
    punto_venta: preparacion.puntoVenta,
    modo: preparacion.modo,
    afip_validez: preparacion.validez,
    cbte_tipo: preparacion.cbteTipo,
    cbte_asoc: cbteAsoc
      ? {
          tipo: cbteAsoc.tipo,
          letra: cbteAsoc.letra,
          punto_venta: cbteAsoc.puntoVenta,
          numero: cbteAsoc.numero,
          fecha: cbteAsoc.fecha,
        }
      : null,
    demora_dias: demoraDias,
    advertencia_demora:
      demoraDias > 5
        ? "La venta comercial tiene más de cinco días; un administrador debe confirmar la emisión con fecha fiscal actual."
        : null,
    confirmacion_factura_a_permitida: facturaAPermitida(vista.letra, vista.contexto),
    confirmacion_autoritativa: copiarConfirmacionFiscal(confirmacionAutoritativa),
    huella_confirmacion: crearHuellaConfirmacionFiscal(confirmacionAutoritativa),
  };
}

export async function previsualizarBorradorFiscalProvisionalServer(input: {
  borrador: EntradaPreviewBorradorFiscal;
  admin: SupabaseLike;
  usuario: SupabaseLike;
  consultarPadron?: typeof consultarPadronArcaDesdeContexto;
}) {
  return construirPreviewBorradorFiscalProvisional(input.borrador, {
    cargarContexto: (sucursalId) => cargarContextoFiscal(input.admin, sucursalId),
    cargarCliente: (clienteId) => cargarCliente(input.usuario, clienteId),
    cargarFavorito: (id) => cargarFavorito(input.usuario, id),
    consultarPadron: (contexto, cuit) => {
      const consultar = consultaPadronParaContexto(contexto, input.admin, input.consultarPadron);
      if (!consultar) throw crearErrorFiscalUsuario("PADRON_CONFIG_INVALIDA");
      return consultar(cuit);
    },
    async cargarProductos(ids) {
      const { data, error } = await input.admin
        .from("productos")
        .select("id,activo,precio_sin_iva,iva_porcentaje")
        .in("id", ids);
      if (error) throw new Error(`No se pudo resolver el catálogo del borrador: ${error.message}.`);
      return (data ?? []).map((producto) => ({
        id: producto.id,
        activo: producto.activo,
        precioSinIva: Number(producto.precio_sin_iva),
        ivaPorcentaje: Number(producto.iva_porcentaje),
      }));
    },
    ahora: () => new Date(),
  });
}
