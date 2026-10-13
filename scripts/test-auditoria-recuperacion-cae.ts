import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cargarAuditoriaNotaCreditoPeriodo } from "../src/components/ventas/dialogo-detalle-venta-auditoria.ts";
import {
  COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA,
  COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA,
  cargarEvidenciaAutorizacionFiscal,
  type FilaEvidenciaAutorizacionSegura,
} from "../src/lib/fiscal/evidencia-auditoria.ts";

type FixtureRecuperacion = {
  ventaId: string;
  ventaConfirmacion: { afip_emitido_at: string };
  ventaAuditada: Parameters<typeof cargarAuditoriaNotaCreditoPeriodo>[0]["venta"];
  intentoUpdatedAt: string;
  intentoSeguro: FilaEvidenciaAutorizacionSegura;
};

const fixturePath = process.env.T11_AUDIT_FIXTURE;
assert(fixturePath, "Falta T11_AUDIT_FIXTURE");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureRecuperacion;

const intentoUpdatedAt = new Date(fixture.intentoUpdatedAt).getTime();
const afipEmitidoAt = new Date(fixture.ventaConfirmacion.afip_emitido_at).getTime();
assert(Number.isFinite(intentoUpdatedAt) && Number.isFinite(afipEmitidoAt));
assert(
  intentoUpdatedAt < afipEmitidoAt,
  `Se esperaba now() del intento < clock_timestamp() de la venta: ${fixture.intentoUpdatedAt} !< ${fixture.ventaConfirmacion.afip_emitido_at}`,
);

const orden: string[] = [];
const evidencia = await cargarEvidenciaAutorizacionFiscal(fixture.ventaId, {
  cargarVenta: async (input) => {
    orden.push("venta-user-bound");
    assert.deepEqual(input, {
      ventaId: fixture.ventaId,
      columnas: COLUMNAS_VENTA_EVIDENCIA_AUTORIZACION_SEGURA,
    });
    return { data: fixture.ventaConfirmacion, error: null };
  },
  cargarIntento: async (input) => {
    orden.push("intento-admin");
    assert.deepEqual(input, {
      ventaId: fixture.ventaId,
      columnas: COLUMNAS_EVIDENCIA_AUTORIZACION_SEGURA,
    });
    return { data: fixture.intentoSeguro, error: null };
  },
});

assert.deepEqual(orden, ["venta-user-bound", "intento-admin"]);
assert.deepEqual(evidencia, {
  origen: "RECUPERACION",
  confirmadoAt: fixture.ventaConfirmacion.afip_emitido_at,
});

const auditoria = await cargarAuditoriaNotaCreditoPeriodo({
  venta: fixture.ventaAuditada,
  cargarOperador: async () => ({
    data: { nombre_completo: "Fixture", username: "fixture" },
    error: null,
  }),
  cargarReintegros: async () => ({ data: [], error: null }),
  cargarStock: async () => ({ data: [], error: null }),
  cargarCuentaCorriente: async () => ({ data: [], error: null }),
  cargarEvidenciaAutorizacion: async () => evidencia,
});

assert.equal(auditoria.fiscal.estado, "SNAPSHOT_V3_VALIDADO");
assert.equal(auditoria.fiscal.lifecycle, "APROBADO");
assert.deepEqual(auditoria.evidenciaAutorizacion, evidencia);
process.stdout.write(
  `✓ recuperación SQL real auditable: ${fixture.intentoUpdatedAt} < ${fixture.ventaConfirmacion.afip_emitido_at}\n`,
);
