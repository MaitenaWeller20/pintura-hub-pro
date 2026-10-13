# Nota de crédito fiscal por período — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir emitir una nota de crédito A, B o C con CAE sin seleccionar una factura puntual, asociándola fiscalmente a un período y aplicando devolución de stock, reintegro o saldo a favor exactamente una vez y sólo después de la autorización de ARCA.

**Architecture:** La NC por período nace en `ventas` como `PENDIENTE_FISCAL`, sin pagos, caja, stock ni cuenta corriente. La cola fiscal vigente congela un snapshot v3 canónico, envía `PeriodoAsoc` por el mismo motor WSFE y, al aprobar o recuperar el CAE, la RPC de transición activa la venta y aplica sus efectos comerciales en la misma transacción. El snapshot v2 y la reversión total con `CbtesAsoc` conservan exactamente su semántica actual.

**Tech Stack:** PostgreSQL/Supabase CLI, TanStack Start, React 19, TypeScript 5.8, Zod, `@arcasdk/core@2.0.0`, Vitest 4, Playwright 1.62 y Vercel Node.js/Fluid Compute.

**Spec:** `docs/superpowers/specs/2026-08-28-nota-credito-fiscal-por-periodo-design.md`

## Global Constraints

- Trabajar sólo en el worktree aislado; no descartar ni mezclar cambios ajenos del árbol principal.
- No aplicar migraciones a producción, desplegar, activar el nuevo feature flag ni solicitar un CAE real durante la implementación automatizada.
- Ejecutar las pruebas fiscales automatizadas con `INVOICING_MOCK_MODE=true`; las respuestas SOAP se representan con fixtures locales.
- Crear cada archivo de migración exclusivamente con `supabase migration new`; no inventar timestamps.
- Mantener el escritor fiscal v2 como único emisor. La NC por período no crea un segundo motor, otra numeración ni otra credencial.
- `nota_credito_periodo_enabled` nace en `false`. El deploy y la activación son pasos distintos.
- Apagar el flag impide nuevas NC y nuevos requests aún no iniciados; nunca impide conciliar, recuperar o persistir una respuesta de un request que ya pudo haber llegado a ARCA.
- Un empleado necesita simultáneamente `puede_facturar` y `puede_emitir_nc_periodo`; un administrador tiene ambas capacidades efectivas por rol. La RPC vuelve a validar permiso, perfil activo y sucursal.
- Una NC fiscal usa exactamente una asociación: `CbtesAsoc` para reversión puntual o `PeriodoAsoc` para el nuevo flujo; nunca ambas ni ninguna.
- El flujo nuevo admite exclusivamente `DEVOLUCION_PRODUCTOS` o `BONIFICACION_AJUSTE`; no mezcla líneas, no admite percepciones/tributos y usa moneda `PES`.
- La resolución económica es total: reintegro por importes que coinciden al centavo con el total o crédito completo en cuenta corriente. No hay combinación ni liquidación parcial.
- El navegador trabaja con magnitudes positivas; `ventas` y `venta_items` conservan el signo comercial negativo de una NC. El snapshot y el payload fiscal vuelven a usar magnitudes positivas.
- Una fila `PENDIENTE_FISCAL` no abre caja y no aparece en reportes comerciales activos. No crea `venta_pagos`, `stock_movimientos`, `caja_movimientos` ni `cuenta_corriente_movimientos`.
- La aprobación y `RECUPERAR_CAE` ejecutan el mismo helper transaccional e idempotente. Un rechazo, una caída o una respuesta incierta no aplican efectos.
- Para un reintegro aprobado, `venta_pagos` negativos y su `caja_sesion_id` explícito son la fuente que ya usa `caja_esperado`; no insertar además un `caja_movimientos` duplicado por el mismo dinero.
- No modificar la forma canónica, el hash ni la validación de snapshots v2 existentes. El snapshot v3 sólo se escribe para una NC por período.
- `ventas.afip_version` sigue siendo la revisión optimista de la máquina de estados; no representa la versión 2/3 del snapshot. La versión documental se lee desde `afip_snapshot->>'version'` y `emision_fiscal_intentos.snapshot_version`.
- Los comprobantes aprobados son inmutables. Una NC pendiente sólo puede cancelarse antes de reservar número o iniciar request; no se edita en el lugar.
- Ningún mensaje visible expone Zod, PostgREST, SQL, JSON, SOAP, claves, certificados o trazas. Una respuesta incierta siempre indica no volver a emitir.
- El mismo certificado WSFE del emisor autoriza `PeriodoAsoc`; no agregar una credencial separada. La vigencia y autorización se verifican en homologación por emisor.
- Si cambia una firma RPC, eliminar la firma anterior antes de crear la nueva para evitar overloads ambiguos en PostgREST.
- Al reescribir una función SQL grande, obtener primero su definición vigente con `pg_get_functiondef` después de `supabase db reset`; no copiar un cuerpo histórico que haya sido reemplazado por migraciones posteriores.
- Cada task sigue RED → GREEN → refactor → pruebas focalizadas → commit local. No hacer push, force-push, rebase, amend ni squash de historia publicada.

---

## File Map

### Database and generated contracts

- Migration generated as `*_nota_credito_periodo_estado_enum.sql`: adds only `PENDIENTE_FISCAL` to `estado_venta`.
- Migration generated as `*_nota_credito_periodo_schema.sql`: adds feature flag, permission, NC-period enums/columns, refund intent table, constraints, RLS and permission RPCs.
- Migration generated as `*_snapshot_fiscal_v3_periodo.sql`: adds the SQL v3 validator, snapshot-version dispatch and v2/v3 integrity constraints.
- Migration generated as `*_crear_nota_credito_periodo_fiscal.sql`: creates the idempotent pending-NC RPC and prevents the insert trigger from opening a cash session.
- Migration generated as `*_lectura_nc_periodo_fiscal.sql`: extends exact fiscal reads and queue/detail projections with period-NC fields.
- Migration generated as `*_efectos_nc_periodo_post_cae.sql`: adds the owner-only effects helper and extends `transicionar_emision_fiscal`/safe cancellation.
- `scripts/test-nota-credito-periodo-schema.sh`: enum, columns, constraints, RLS, flag and privilege contract.
- `scripts/test-nota-credito-periodo-fiscal.sh`: permission, creation, idempotency, no-effects-before-CAE and exact-effects-after-CAE contract.
- `scripts/test-snapshot-fiscal-v3.sh`: canonical SQL snapshot validation, tamper rejection and v2 compatibility.
- `scripts/test-venta-fiscal-atomica.sh`: regression additions for linked NC and transition idempotency.
- `scripts/test-receptor-fiscal-schema.sh`: regression additions for the new profile capability and self-elevation guard.
- `src/integrations/supabase/types.ts`: regenerated only after every local migration passes.

### Fiscal domain and ARCA engine

- `src/lib/fiscal/nota-credito-periodo.ts`, `nota-credito-periodo.test.ts`: discriminated input, dates, modes, line/totals and settlement rules.
- `src/lib/fiscal/codigos.ts`, `fiscal.test.ts`: automatic A/B/C matrix for a period NC and standard-NC allowlist.
- `src/lib/fiscal/snapshot.ts`, `snapshot.test.ts`: snapshot v3 plus `SnapshotFiscalPersistido` reader without changing v2.
- `src/lib/fiscal/arca.ts`, `arca.test.ts`, `arca-runtime.test.ts`: `PeriodoAsoc` request and `FECompConsultar` normalization.
- `src/lib/fiscal/reconciliacion.ts`, `reconciliacion.test.ts`: exact v2/v3 association comparison.
- `src/lib/fiscal/receptor.ts`, `receptor.server.ts`, `receptor.test.ts`, `receptor.server.test.ts`: normal receiver selectors for a period NC and inherited receiver for a linked NC.
- `src/lib/fiscal/emision.ts`, `emision.test.ts`: discriminated association and persisted-snapshot union in the deterministic engine.
- `src/lib/fiscal/emision.server.ts`, `emision.server.test.ts`, `emision.integration.test.ts`: exact DB read, automatic letter and snapshot-v3 construction.
- `src/lib/fiscal/emision-legacy.server.ts`: keeps true internal notes separate without misclassifying period NCs.
- `src/lib/fiscal/error-usuario.ts`, `error-usuario.test.ts`: field-specific errors and exact outage/uncertainty messages.
- `src/lib/fiscal/feature.server.ts`, `feature.server.test.ts`: authoritative new flag read on every write.
- `src/lib/fiscal/impresion.ts`, `impresion.test.ts`, `comprobante-pdf.ts`, `comprobante-pdf.test.ts`: fail-closed v3 printing with period, mode and reason.

### Server facade, permissions and UI

- `src/lib/ventas.functions.ts`, `ventas.functions.test.ts`: strict server action for pending period NC; existing linked/legacy paths remain separate.
- `src/lib/usuarios.functions.ts`, `usuarios.functions.test.ts`: admin-only capability mutation.
- `src/hooks/use-current-user.ts`, `use-current-user.test.ts`: effective `puedeEmitirNcPeriodo`.
- `src/lib/nota-credito-periodo-ui.ts`, `nota-credito-periodo-ui.test.ts`: pure UI state/summary mapping.
- `src/components/ventas/editor-nota-credito-periodo.tsx`: focused editor for period, mode, lines and full settlement.
- `src/components/fiscal/dialogo-emision-fiscal.tsx`, `dialogo-emision-validacion.ts`, `dialogo-emision-validacion.test.ts`, `resumen-emision-fiscal.tsx`: receiver validation and final confirmation for period association.
- `src/routes/_authenticated/ventas.nueva.tsx`: selector between linked reversal and period association.
- `src/routes/_authenticated/ventas.index.tsx`: period-aware fiscal/internal classification and approved-note detail entry.
- `src/routes/_authenticated/usuarios.tsx`: new permission toggle.
- `src/routes/_authenticated/facturacion.cola.tsx`, `src/lib/fiscal/cola.functions.ts`, `cola.test.ts`: pending period NC visible in fiscal queue while excluded from commercial reports.
- `src/components/ventas/dialogo-detalle-venta.tsx`: operator, client, receiver, period, reason, mode and applied effects.
- `e2e/fixtures/fiscal.ts`, `e2e/nota-credito-periodo.spec.ts`: complete mock browser stories.
- `e2e/nota-credito.spec.ts`, `e2e/nota-credito-guardar.spec.ts`, `e2e/facturacion-cola.spec.ts`: regression coverage.
- `docs/facturacion-receptor-fiscal-operacion.md`: rollout, homologation, monitoring and rollback runbook.

---

### Task 1: Establish a green baseline and add `PENDIENTE_FISCAL` safely

**Files:**

- Create: migration path printed by `supabase migration new nota_credito_periodo_estado_enum`

**Interfaces:**

- Adds only `PENDIENTE_FISCAL` to `public.estado_venta`.
- Keeps the enum change in a transaction separate from every insert or constraint that uses the new value.

- [ ] **Step 1: Record the baseline in the isolated worktree**

Run:

```bash
git status --short --branch
npm test
npm run typecheck
INVOICING_MOCK_MODE=true npm run build:vercel
```

Expected: the current suite, typecheck and mock build pass. Record any pre-existing failure before continuing and do not fold an unrelated repair into this feature.

- [ ] **Step 2: Generate the enum migration and write the failing assertion**

Run:

```bash
supabase migration new nota_credito_periodo_estado_enum
NC_ENUM_MIGRATION="$(rg --files supabase/migrations | rg 'nota_credito_periodo_estado_enum\.sql$' | sort | tail -1)"
test -n "$NC_ENUM_MIGRATION"
supabase db reset
docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc \
  "select exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='estado_venta' and e.enumlabel='PENDIENTE_FISCAL');"
```

Expected before editing: `f`.

- [ ] **Step 3: Add only the enum value**

```sql
ALTER TYPE public.estado_venta
  ADD VALUE IF NOT EXISTS 'PENDIENTE_FISCAL';
```

Do not reference `PENDIENTE_FISCAL` anywhere else in this migration.

- [ ] **Step 4: Prove the migration is independently usable**

Run:

```bash
supabase db reset
docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc \
  "select exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='estado_venta' and e.enumlabel='PENDIENTE_FISCAL');"
```

Expected: `t`.

- [ ] **Step 5: Commit the isolated enum migration**

```bash
git add "$NC_ENUM_MIGRATION"
git commit -m "feat(fiscal): agregar estado pendiente para notas"
```

---

### Task 2: Add the flag, capability and durable period-NC schema

**Files:**

- Create: `scripts/test-nota-credito-periodo-schema.sh`
- Create: migration path printed by `supabase migration new nota_credito_periodo_schema`
- Modify: `scripts/test-receptor-fiscal-schema.sh`

**Interfaces:**

- `settings.nota_credito_periodo_enabled boolean NOT NULL DEFAULT false`.
- `profiles.puede_emitir_nc_periodo boolean NOT NULL DEFAULT false`.
- `public.puede_emitir_nc_periodo(_uid uuid DEFAULT auth.uid()) RETURNS boolean`.
- `public.administrar_puede_emitir_nc_periodo(p_profile_id uuid, p_habilitado boolean) RETURNS void`.
- `ventas` fields `nc_periodo_modalidad`, `periodo_asoc_desde`, `periodo_asoc_hasta`, `motivo_nota_credito`, `nc_resolucion`, `nc_periodo_payload_hash`, `nc_efectos_aplicados_at`.
- `nota_credito_periodo_reintegros` stores immutable payment intent before CAE; it is not a cash movement.
- Database guards make period-NC parent/children server-only and reject any post-CAE mutation outside the trusted transition.

- [ ] **Step 1: Write a failing schema contract**

Generate the migration:

```bash
supabase migration new nota_credito_periodo_schema
NC_SCHEMA_MIGRATION="$(rg --files supabase/migrations | rg 'nota_credito_periodo_schema\.sql$' | sort | tail -1)"
test -n "$NC_SCHEMA_MIGRATION"
```

Create `scripts/test-nota-credito-periodo-schema.sh` using the same local-Postgres harness as `scripts/test-receptor-fiscal-schema.sh`. Assert all of these before implementation:

```sql
SELECT nota_credito_periodo_enabled FROM public.settings WHERE id=true;
SELECT puede_emitir_nc_periodo FROM public.profiles LIMIT 1;
SELECT nc_periodo_modalidad,periodo_asoc_desde,periodo_asoc_hasta,
       motivo_nota_credito,nc_resolucion,nc_periodo_payload_hash,
       nc_efectos_aplicados_at
  FROM public.ventas LIMIT 0;
SELECT venta_id,forma_pago,monto,detalle,orden
  FROM public.nota_credito_periodo_reintegros LIMIT 0;
```

Also assert:

- a non-NC cannot carry period fields;
- a period NC cannot carry `afip_cbte_asoc_id`;
- partial period data is rejected;
- `desde > hasta` is rejected;
- motive shorter than five trimmed characters is rejected;
- direct `INSERT/UPDATE/DELETE` on the refund-intent table is denied to `authenticated`;
- direct authenticated insert/update/delete of a period NC, its `venta_items` or its `venta_pagos` is rejected;
- an approved period NC cannot be updated or deleted through ordinary table privileges;
- an employee cannot self-enable the new profile column;
- an admin is effectively allowed even when the stored column is false;
- an employee requires `activo AND puede_facturar AND puede_emitir_nc_periodo`.

Run:

```bash
bash scripts/test-nota-credito-periodo-schema.sh
```

Expected: failure because the schema does not exist.

- [ ] **Step 2: Add the exact types and columns**

Use this shape in the generated migration:

```sql
CREATE TYPE public.modalidad_nc_periodo AS ENUM (
  'DEVOLUCION_PRODUCTOS',
  'BONIFICACION_AJUSTE'
);

CREATE TYPE public.resolucion_nc_periodo AS ENUM (
  'REINTEGRO',
  'SALDO_FAVOR'
);

ALTER TABLE public.settings
  ADD COLUMN nota_credito_periodo_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN puede_emitir_nc_periodo boolean NOT NULL DEFAULT false;

ALTER TABLE public.ventas
  ADD COLUMN nc_periodo_modalidad public.modalidad_nc_periodo,
  ADD COLUMN periodo_asoc_desde date,
  ADD COLUMN periodo_asoc_hasta date,
  ADD COLUMN motivo_nota_credito text,
  ADD COLUMN nc_resolucion public.resolucion_nc_periodo,
  ADD COLUMN nc_periodo_payload_hash text,
  ADD COLUMN nc_efectos_aplicados_at timestamptz;
```

Add named checks with these invariants:

```sql
-- Every period field is absent, or every period field is present on a period NC.
CHECK (
  (
    nc_periodo_modalidad IS NULL AND periodo_asoc_desde IS NULL
    AND periodo_asoc_hasta IS NULL AND motivo_nota_credito IS NULL
    AND nc_resolucion IS NULL AND nc_periodo_payload_hash IS NULL
    AND nc_efectos_aplicados_at IS NULL
  )
  OR (
    tipo_comprobante='NOTA_CREDITO'
    AND afip_cbte_asoc_id IS NULL
    AND nc_periodo_modalidad IS NOT NULL
    AND periodo_asoc_desde IS NOT NULL
    AND periodo_asoc_hasta IS NOT NULL
    AND periodo_asoc_desde <= periodo_asoc_hasta
    AND length(btrim(motivo_nota_credito)) >= 5
    AND nc_resolucion IS NOT NULL
    AND nc_periodo_payload_hash ~ '^[0-9a-f]{64}$'
  )
);

-- A linked NC never also carries a period.
CHECK (
  afip_cbte_asoc_id IS NULL
  OR (
    periodo_asoc_desde IS NULL AND periodo_asoc_hasta IS NULL
    AND nc_periodo_modalidad IS NULL AND nc_resolucion IS NULL
  )
);

-- Effects belong only to a period NC which has reached commercial ACTIVA.
CHECK (
  nc_efectos_aplicados_at IS NULL
  OR (nc_periodo_modalidad IS NOT NULL AND estado='ACTIVA')
);
```

Do not impose “every historical NC must have one association” at table level: legacy internal NC rows are valid history. The new RPC and fiscal transition enforce the stronger rule for new fiscal rows.

- [ ] **Step 3: Add immutable refund intent with RLS**

```sql
CREATE TABLE public.nota_credito_periodo_reintegros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id uuid NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  forma_pago public.forma_pago NOT NULL CHECK (forma_pago <> 'CTA_CTE'),
  monto numeric(14,2) NOT NULL CHECK (monto > 0),
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  orden integer NOT NULL CHECK (orden >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venta_id,orden)
);

ALTER TABLE public.nota_credito_periodo_reintegros ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.nota_credito_periodo_reintegros TO authenticated,service_role;
GRANT ALL ON public.nota_credito_periodo_reintegros TO service_role;
```

Add a `SELECT` policy through the parent `ventas` row using admin/current-sucursal visibility. Do not grant authenticated writes and do not add a write policy.

Extend the latest `guard_ventas_columnas` and add focused trigger guards on `ventas`, `venta_items` and `venta_pagos`:

- direct `authenticated` DML cannot create or mutate a row whose parent has `nc_periodo_modalidad IS NOT NULL`;
- deleting a period NC is rejected; safe cancellation updates state through the transition instead;
- once `afip_estado='APROBADO'` or `nc_efectos_aplicados_at IS NOT NULL`, every non-owner write is rejected even if a broad legacy RLS policy would otherwise allow it;
- the `SECURITY DEFINER` creation/transition functions remain the only trusted writers.

Use separate trigger functions for `ventas` and child tables so `OLD/NEW` fields are type-safe. Revoke execution on those trigger functions from every API role.

- [ ] **Step 4: Add effective permission and admin mutation**

Implement the capability exactly as:

```sql
CREATE OR REPLACE FUNCTION public.puede_emitir_nc_periodo(
  _uid uuid DEFAULT auth.uid()
) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT public.is_admin(_uid)
      OR COALESCE((
        SELECT p.activo AND p.puede_facturar AND p.puede_emitir_nc_periodo
          FROM public.profiles AS p
         WHERE p.id=_uid
      ),false);
$$;
```

Model `administrar_puede_emitir_nc_periodo` after `administrar_puede_facturar`: require an active authenticated admin, lock the target profile, update only the new column, and revoke `PUBLIC/anon` before granting `authenticated,service_role`. Extend the latest `guard_profiles_columnas` body so direct profile updates cannot change either fiscal capability.

- [ ] **Step 5: Run the schema and existing privilege tests**

```bash
supabase db reset
bash scripts/test-nota-credito-periodo-schema.sh
bash scripts/test-receptor-fiscal-schema.sh
```

Expected: both pass; the setting and profile column remain `false` after reset.

- [ ] **Step 6: Commit the durable schema**

```bash
git add "$NC_SCHEMA_MIGRATION" scripts/test-nota-credito-periodo-schema.sh scripts/test-receptor-fiscal-schema.sh
git commit -m "feat(fiscal): modelar notas de crédito por período"
```

---

### Task 3: Define period-NC rules and the A/B/C matrix in pure TypeScript

**Files:**

- Create: `src/lib/fiscal/nota-credito-periodo.ts`
- Create: `src/lib/fiscal/nota-credito-periodo.test.ts`
- Modify: `src/lib/fiscal/codigos.ts`
- Modify: `src/lib/fiscal/fiscal.test.ts`

**Interfaces:**

```ts
export type ModalidadNcPeriodo = "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE";
export type ResolucionNcPeriodo = "REINTEGRO" | "SALDO_FAVOR";
export type FormaPagoReintegro =
  | "EFECTIVO"
  | "TRANSFERENCIA"
  | "TARJETA_DEBITO"
  | "TARJETA_CREDITO"
  | "MERCADO_PAGO"
  | "CHEQUE";
export type AsociacionFiscal =
  | { tipo: "NINGUNA" }
  | { tipo: "COMPROBANTE"; comprobanteOriginalId: string }
  | { tipo: "PERIODO"; desde: string; hasta: string };

export type LineaCalculableNcPeriodo = {
  cantidad: number;
  precioUnitarioSinIva: number;
  ivaPorcentaje: number;
};
export type TotalesNotaCreditoPeriodo = {
  netoCentavos: number;
  ivaCentavos: number;
  totalCentavos: number;
};

export const notaCreditoPeriodoInputSchema: z.ZodType<NotaCreditoPeriodoInput>;
export function calcularTotalesNotaCreditoPeriodo(
  lineas: readonly LineaCalculableNcPeriodo[],
): TotalesNotaCreditoPeriodo;
export function validarLiquidacionNotaCreditoPeriodo(input: {
  resolucion: ResolucionNcPeriodo;
  totalCentavos: number;
  pagos: readonly { formaPago: FormaPagoReintegro; montoCentavos: number }[];
  clienteId: string;
}): void;
export function validarPeriodoAsociado(input: {
  desde: string;
  hasta: string;
  fechaEmision: string;
}): void;
export function determinarLetraNcPeriodo(
  emisor: CondicionIva,
  receptor: CondicionIva,
): Letra;
```

- [ ] **Step 1: Write the failing domain tests**

Cover these exact cases:

- dates are real `YYYY-MM-DD`, both required, `desde <= hasta <= fechaEmision` and no defaults;
- reason is trimmed and has at least five characters;
- `DEVOLUCION_PRODUCTOS` requires one or more positive product lines and rejects a free concept;
- `BONIFICACION_AJUSTE` requires exactly one line with `producto_id=null`, description, positive net amount and allowed IVA;
- zero quantity, negative price, unknown IVA and mixed lines fail;
- totals round per line to two decimals and aggregate net/IVA/total as positive magnitudes;
- `REINTEGRO` requires no `CTA_CTE` payment and an exact cent total;
- `SALDO_FAVOR` requires zero payment rows and a commercial client;
- any partial or mixed settlement fails;
- association union accepts ordinary invoice/none, linked NC/receipt and period NC/period, rejecting both/none for a fiscal NC;
- RI emitter produces A for RI/monotributo and B for exempt/final consumer;
- monotributo emitter produces C for every supported receiver condition;
- standard period NC type is restricted to ARCA `3`, `8` or `13`, so future FCE types fail before request.
- `esNotaInterna` returns `false` for a period NC even though `afip_cbte_asoc_id` is null, while a legacy NC with neither receipt nor period remains internal.

Run:

```bash
npx vitest run src/lib/fiscal/nota-credito-periodo.test.ts src/lib/fiscal/fiscal.test.ts
```

Expected: failure because the module/functions are absent.

- [ ] **Step 2: Implement a strict discriminated schema**

Use a common strict base plus `z.discriminatedUnion("modalidad", [devolucion, ajuste])`. The two line shapes must not share optional fields that could silently permit mixing:

```ts
const devolucion = base.extend({
  modalidad: z.literal("DEVOLUCION_PRODUCTOS"),
  items: z.array(itemProductoSchema.strict()).min(1),
});

const ajuste = base.extend({
  modalidad: z.literal("BONIFICACION_AJUSTE"),
  items: z.tuple([itemConceptoSchema.strict()]),
});
```

Keep `idempotency_key`, `sucursal_id`, `cliente_id`, `periodo_desde`, `periodo_hasta`, `motivo`, `resolucion` and `pagos` in the common browser/server input. Reject unknown keys with `.strict()`. The caller never supplies `fecha_emision`: UI may validate against today for feedback, PostgreSQL validates against its Córdoba date, and snapshot creation revalidates against the reserved fiscal date.

- [ ] **Step 3: Implement deterministic cent calculations and settlement**

Calculate from server-resolved catalog/override values, never from totals sent by the browser:

```ts
const netoLinea = redondear2(cantidad * precioUnitarioSinIva);
const ivaLinea = redondear2(netoLinea * ivaPorcentaje / 100);
const totalLinea = redondear2(netoLinea + ivaLinea);
```

Compare settlement in integer cents, not floating-point epsilon. Return positive magnitudes; document that persistence applies the NC sign once.

- [ ] **Step 4: Add the automatic NC-period letter matrix without changing linked-NC inheritance**

`determinarLetraNcPeriodo` handles RI and monotributo emitters. Keep `validarLetraSolicitada` for the existing explicit A/B invoice flow and keep linked NC letter derivation from its original snapshot.

Change the internal-note classifier to receive both possible association shapes:

```ts
export function esNotaInterna(
  tipo: string,
  afipCbteAsocId: string | null | undefined,
  periodoDesde?: string | null,
  periodoHasta?: string | null,
): boolean;
```

It returns true only for an NC/ND with neither receipt nor complete period. Update every caller that reads persisted sales to pass both period fields; legacy-only callers pass null explicitly.

- [ ] **Step 5: Run and commit the pure domain**

```bash
npx vitest run src/lib/fiscal/nota-credito-periodo.test.ts src/lib/fiscal/fiscal.test.ts
npm run typecheck
git add src/lib/fiscal/nota-credito-periodo.ts src/lib/fiscal/nota-credito-periodo.test.ts src/lib/fiscal/codigos.ts src/lib/fiscal/fiscal.test.ts
git commit -m "feat(fiscal): validar nota de crédito por período"
```

---

### Task 4: Create the pending NC idempotently without commercial effects

**Files:**

- Create: migration path printed by `supabase migration new crear_nota_credito_periodo_fiscal`
- Create: `scripts/test-nota-credito-periodo-fiscal.sh`

**Interfaces:**

```sql
public.crear_nota_credito_periodo_fiscal(
  p_sucursal_id uuid,
  p_cliente_id uuid,
  p_modalidad public.modalidad_nc_periodo,
  p_periodo_desde date,
  p_periodo_hasta date,
  p_motivo text,
  p_resolucion public.resolucion_nc_periodo,
  p_items jsonb,
  p_reintegros jsonb,
  p_idempotency_key uuid
) RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
```

- [ ] **Step 1: Write the failing integration scenarios**

Generate the migration first:

```bash
supabase migration new crear_nota_credito_periodo_fiscal
NC_CREATE_MIGRATION="$(rg --files supabase/migrations | rg 'crear_nota_credito_periodo_fiscal\.sql$' | sort | tail -1)"
test -n "$NC_CREATE_MIGRATION"
```

Build fixtures through SQL helper functions already used by `scripts/test-venta-fiscal-atomica.sh`. Prove:

- disabled flag rejects both admin and employee;
- inactive profile, wrong branch and employee without both capabilities are rejected;
- admin and fully authorized employee can create;
- inactive/missing client, missing dates, future end date and short reason are rejected; the strict server input rejects a `percepciones` key and the RPC always persists zero;
- product mode locks active catalog rows, permits audited price override, and rejects concept/null product;
- adjustment mode accepts exactly one null-product concept and rejects product/multiple concepts;
- reintegro sum is exact and account credit has no planned payments;
- the row is `NOTA_CREDITO`, `PENDIENTE_FISCAL`, `SIN_FACTURAR`, has negative totals and no point/number/CAE/snapshot;
- no cash session is opened by creation and all stock/payment/cash/current-account counts stay unchanged;
- retrying the same idempotency key and same canonical payload returns the same `venta_id`;
- reusing the key with changed payload or another actor fails;
- concurrent identical calls produce one row;
- legacy internal NC and linked total reversal still use their existing RPCs.

Run:

```bash
supabase db reset
bash scripts/test-nota-credito-periodo-fiscal.sh
```

Expected: failure because the RPC is absent.

- [ ] **Step 2: Prevent a pending fiscal insert from opening cash**

Replace `public.estampar_caja_sesion()` from its current `pg_get_functiondef` and add this guard before calling `caja_sesion_actual`:

```sql
IF TG_TABLE_SCHEMA='public'
   AND TG_TABLE_NAME='ventas'
   AND pg_catalog.to_jsonb(NEW)->>'estado'='PENDIENTE_FISCAL' THEN
  RETURN NEW;
END IF;
```

The function is shared by other tables; use `to_jsonb(NEW)` under the table-name guard so cobranzas/compras without `estado_venta` keep working.

- [ ] **Step 3: Implement authoritative validation and price resolution**

Inside a `SECURITY DEFINER SET search_path=''` RPC:

1. require `auth.uid()`, active profile and accessible active branch;
2. lock/read the singleton settings row and require v2 on, legacy writer off and the new flag on;
3. require `public.puede_emitir_nc_periodo(v_uid)`;
4. validate active commercial client, dates against `(now() AT TIME ZONE 'America/Argentina/Cordoba')::date`, trimmed reason, mode and resolution;
5. canonicalize `p_items` and `p_reintegros` in deterministic order;
6. resolve products, list prices and allowed overrides under row lock; calculate every amount in `numeric`, not JavaScript;
7. require exact reintegro or exact account credit and zero perceptions/tributes.

- [ ] **Step 4: Implement hard idempotency**

Take an advisory transaction lock from `p_idempotency_key`, compute a SHA-256 over the canonical business payload plus actor, and persist it in `ventas.nc_periodo_payload_hash`. Reuse the existing `ventas.idempotency_key` unique path only when the existing row has the same hash and actor. A different hash must raise a typed conflict rather than return unrelated data.

- [ ] **Step 5: Persist intent only**

Insert:

- one `ventas` row with negative net/IVA/total, `total_pagado=0`, `estado='PENDIENTE_FISCAL'`, `afip_estado='SIN_FACTURAR'` and explicit period/mode/reason/resolution; persist `condicion_venta='CONTADO'` for `REINTEGRO` and `condicion_venta='CTA_CTE'` for `SALDO_FAVOR`;
- product or concept rows in `venta_items`, with negative subtotals and `producto_id=NULL` only for adjustment; the single adjustment row uses `codigo='AJUSTE'`, `cantidad=1`, `precio_lista_sin_iva=precio_unitario_sin_iva` and zero discount;
- positive intended refund rows only in `nota_credito_periodo_reintegros`.

Do not call `cc_registrar_por_venta`, `caja_sesion_actual` or any stock helper. Do not insert `venta_pagos` or movement rows.

- [ ] **Step 6: Restrict grants and pass the integration contract**

```sql
REVOKE ALL ON FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crear_nota_credito_periodo_fiscal(
  uuid,uuid,public.modalidad_nc_periodo,date,date,text,
  public.resolucion_nc_periodo,jsonb,jsonb,uuid
) TO authenticated,service_role;
```

Run:

```bash
supabase db reset
bash scripts/test-nota-credito-periodo-schema.sh
bash scripts/test-nota-credito-periodo-fiscal.sh
bash scripts/test-venta-fiscal-atomica.sh
```

- [ ] **Step 7: Commit pending creation**

```bash
git add "$NC_CREATE_MIGRATION" scripts/test-nota-credito-periodo-fiscal.sh
git commit -m "feat(fiscal): crear notas por período pendientes"
```

---

### Task 5: Introduce canonical snapshot v3 with SQL/TypeScript parity

**Files:**

- Modify: `src/lib/fiscal/snapshot.ts`
- Modify: `src/lib/fiscal/snapshot.test.ts`
- Create: `scripts/test-snapshot-fiscal-v3.sh`
- Create: migration path printed by `supabase migration new snapshot_fiscal_v3_periodo`

**Interfaces:**

```ts
export type PeriodoAsocSnapshotFiscal = { desde: string; hasta: string };
export type SnapshotFiscalV3 = Omit<SnapshotFiscalV2, "version" | "hash" | "origen" |
  "comprobanteOriginalId" | "cbtesAsoc"> & {
  version: 3;
  hash: string;
  origen: "PERIODO_ASOCIADO";
  comprobanteOriginalId: null;
  cbtesAsoc: [];
  periodoAsoc: PeriodoAsocSnapshotFiscal;
  notaCredito: {
    modalidad: ModalidadNcPeriodo;
    motivo: string;
  };
};

export type SnapshotFiscalPersistido = SnapshotFiscalV2 | SnapshotFiscalV3;
export function crearSnapshotFiscalV3(input: SnapshotFiscalV3Input): SnapshotFiscalV3;
export function validarSnapshotFiscalV3(value: unknown): SnapshotFiscalV3;
export function validarSnapshotFiscalPersistido(value: unknown): SnapshotFiscalPersistido;
```

- [ ] **Step 1: Write failing snapshot-v3 tests**

Copy a valid v2 fixture through its public factory, then construct v3 through the new factory. Assert:

- exact key allowlist/order, `version=3`, origin, empty `cbtesAsoc`, null original, period and note metadata;
- total/net/IVA/lines/receptor/identity remain canonical and positive;
- invalid/nonexistent dates, reversed period, period after issue date, short reason, unknown mode, non-NC type and nonstandard NC CbteTipo fail;
- adding/removing/reordering an unexpected key or changing one byte fails hash validation;
- serializing the same input twice yields the same bytes/hash;
- `validarSnapshotFiscalPersistido` accepts unchanged v2 fixtures and new v3 fixtures;
- `validarSnapshotFiscalV2` still rejects v3 and its existing golden tests remain byte-identical.

Run:

```bash
npx vitest run src/lib/fiscal/snapshot.test.ts
```

Expected: failure on absent v3 exports.

- [ ] **Step 2: Add v3 by reusing canonical primitives, not loosening v2**

Keep `validarCuerpoV2` and the v2 key allowlist unchanged. Extract only truly shared validators/serialization primitives. Dispatch before validation:

```ts
export function validarSnapshotFiscalPersistido(value: unknown) {
  const version = esRegistro(value) ? value.version : undefined;
  if (version === 2) return validarSnapshotFiscalV2(value);
  if (version === 3) return validarSnapshotFiscalV3(value);
  throw new Error("La versión del snapshot fiscal no está soportada.");
}
```

- [ ] **Step 3: Write the failing SQL parity contract**

Generate the migration and create `scripts/test-snapshot-fiscal-v3.sh`:

```bash
supabase migration new snapshot_fiscal_v3_periodo
NC_SNAPSHOT_MIGRATION="$(rg --files supabase/migrations | rg 'snapshot_fiscal_v3_periodo\.sql$' | sort | tail -1)"
test -n "$NC_SNAPSHOT_MIGRATION"
```

The script must feed a TypeScript-generated v3 fixture to PostgreSQL and assert the same accept/reject matrix, including one-field tampering and unchanged v2 acceptance.

- [ ] **Step 4: Implement SQL v3 validation and version dispatch**

Add owner-only helpers:

```sql
public.validar_snapshot_fiscal_v3(p_snapshot jsonb) RETURNS void
public.validar_snapshot_fiscal_persistido(p_snapshot jsonb) RETURNS integer
```

The dispatch returns `2` or `3`, calls the exact validator, and rejects every other version. V3 validates exact keys, canonical decimals/CUIT/dates/hash, `tipoComprobante='NOTA_CREDITO'`, `origen='PERIODO_ASOCIADO'`, empty `cbtesAsoc`, null original, period order/end date, mode/line rules, zero tributes and CbteTipo `3/8/13`. Settlement stays in immutable commercial columns/movements and is deliberately not added to the fiscal snapshot approved by the spec.

Recreate the latest `ck_ventas_afip_snapshot_coherente` and `ck_ventas_afip_estado_integridad` checks so a persisted snapshot may be v2 or v3, with this additional coherence:

- a row with `nc_periodo_modalidad IS NOT NULL` must persist v3;
- every other new fiscal row must persist v2;
- `RECONCILIAR`, `EMITIENDO` and `APROBADO` continue requiring a valid snapshot/hash/identity.

Do not compare snapshot version to `ventas.afip_version`.

- [ ] **Step 5: Prove cross-runtime parity**

```bash
supabase db reset
npx vitest run src/lib/fiscal/snapshot.test.ts
bash scripts/test-snapshot-fiscal-v3.sh
bash scripts/test-venta-fiscal-atomica.sh
```

- [ ] **Step 6: Commit snapshot v3**

```bash
git add "$NC_SNAPSHOT_MIGRATION" scripts/test-snapshot-fiscal-v3.sh src/lib/fiscal/snapshot.ts src/lib/fiscal/snapshot.test.ts
git commit -m "feat(fiscal): agregar snapshot v3 por período"
```

---

### Task 6: Send and reconcile `PeriodoAsoc` through the ARCA adapter

**Files:**

- Modify: `src/lib/fiscal/arca.ts`
- Modify: `src/lib/fiscal/arca.test.ts`
- Modify: `src/lib/fiscal/arca-runtime.test.ts`
- Modify: `src/lib/fiscal/reconciliacion.ts`
- Modify: `src/lib/fiscal/reconciliacion.test.ts`

**Interfaces:**

- `crearPayloadCaeDesdeSnapshot(snapshot: SnapshotFiscalPersistido)`.
- `ComprobanteArcaConsultado.periodoAsoc: { desde: string; hasta: string } | null`.
- `compararSnapshotConArca(snapshot: SnapshotFiscalPersistido, remoto)`.
- `decidirConciliacion` accepts either persisted snapshot version.

- [ ] **Step 1: Add failing payload and response-normalization tests**

Assert the exact object passed to `@arcasdk/core`:

```ts
expect(detalle.PeriodoAsoc).toEqual({
  FchDesde: "20260801",
  FchHasta: "20260815",
});
expect(detalle).not.toHaveProperty("CbtesAsoc");
```

Also assert:

- v2 linked NC still emits only `CbtesAsoc`;
- ordinary v2 invoice emits neither association;
- malformed v3 cannot reach the SDK;
- `normalizarComprobanteArca` converts `ResultGet.PeriodoAsoc` to ISO dates;
- missing one date, invalid date or response containing both associations fails closed;
- runtime mock inspection proves the nested property survives the SDK call.

Run:

```bash
npx vitest run src/lib/fiscal/arca.test.ts src/lib/fiscal/arca-runtime.test.ts
```

- [ ] **Step 2: Add the v3 payload branch**

After validating the persisted snapshot, serialize exactly:

```ts
if (snapshot.version === 3) {
  payload.PeriodoAsoc = {
    FchDesde: snapshot.periodoAsoc.desde.replaceAll("-", ""),
    FchHasta: snapshot.periodoAsoc.hasta.replaceAll("-", ""),
  };
} else if (snapshot.cbtesAsoc.length > 0) {
  payload.CbtesAsoc = snapshot.cbtesAsoc.map((row) => ({
    Tipo: row.tipo,
    PtoVta: row.puntoVenta,
    Nro: row.numero,
    Cuit: row.cuit,
    CbteFch: row.fecha.replaceAll("-", ""),
  }));
}
```

- [ ] **Step 3: Normalize and compare period association exactly**

For v3, reconciliation requires remote `periodoAsoc` equal to local dates and zero remote associated receipts. For v2, retain the current `cbtesAsoc` comparison and require remote period absent. Differences expose paths only:

```text
periodoAsoc.desde
periodoAsoc.hasta
cbtesAsoc.length
```

Never include CUITs, amounts or SOAP values in the differences array.

- [ ] **Step 4: Pass adapter and reconciliation regressions**

```bash
npx vitest run \
  src/lib/fiscal/arca.test.ts \
  src/lib/fiscal/arca-runtime.test.ts \
  src/lib/fiscal/reconciliacion.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit ARCA period support**

```bash
git add src/lib/fiscal/arca.ts src/lib/fiscal/arca.test.ts src/lib/fiscal/arca-runtime.test.ts src/lib/fiscal/reconciliacion.ts src/lib/fiscal/reconciliacion.test.ts
git commit -m "feat(fiscal): enviar y conciliar período asociado"
```

---

### Task 7: Extend receiver resolution and the deterministic emitter

**Files:**

- Modify: `src/lib/fiscal/receptor.ts`
- Modify: `src/lib/fiscal/receptor.server.ts`
- Modify: `src/lib/fiscal/receptor.test.ts`
- Modify: `src/lib/fiscal/receptor.server.test.ts`
- Modify: `src/lib/fiscal/codigos.ts`
- Modify: `src/routes/_authenticated/ventas.index.tsx`
- Modify: `src/lib/fiscal/emision-legacy.server.ts`
- Modify: `src/lib/fiscal/emision.ts`
- Modify: `src/lib/fiscal/emision.test.ts`
- Modify: `src/lib/fiscal/emision.server.ts`
- Modify: `src/lib/fiscal/emision.server.test.ts`
- Modify: `src/lib/fiscal/emision.integration.test.ts`
- Create: migration path printed by `supabase migration new lectura_nc_periodo_fiscal`

**Interfaces:**

```ts
export type AsociacionPreparadaFiscal =
  | { tipo: "NINGUNA" }
  | { tipo: "COMPROBANTE"; original: SnapshotFiscalV2 }
  | {
      tipo: "PERIODO";
      desde: string;
      hasta: string;
      modalidad: ModalidadNcPeriodo;
      motivo: string;
      resolucion: ResolucionNcPeriodo;
    };

export type SeleccionLetraFiscal =
  | { origen: "EXPLICITA"; letra: "A" | "B" }
  | { origen: "AUTOMATICA_NC_PERIODO" };
```

`PreparacionEmisionFiscal` gains `asociacion`; persisted reservation/snapshot dependencies use `SnapshotFiscalPersistido`.

- [ ] **Step 1: Write failing association/receiver tests**

Cover:

- linked NC accepts only `COMPROBANTE_ORIGINAL` and still inherits the approved v2 receiver/letter;
- period NC rejects `COMPROBANTE_ORIGINAL` and accepts commercial/favorite/manual selectors;
- commercial/manual/favorite CUIT paths all consult the current padrón when validation is active;
- manual free text never overrides razón social/condition returned by ARCA;
- a period NC with neither/both associations fails before claim/reservation;
- period NC derives A/B/C from emitter + confirmed receiver; it is not user-selectable;
- FCE/nonstandard NC type is rejected before `REQUEST_INICIADO`;
- period NC is never classified as a legacy internal note in the sales list or emitter;
- engine reservations, payloads and reconciliation accept v2/v3 unions without changing v2 traces.

Run:

```bash
npx vitest run \
  src/lib/fiscal/receptor.test.ts \
  src/lib/fiscal/receptor.server.test.ts \
  src/lib/fiscal/emision.test.ts \
  src/lib/fiscal/emision.server.test.ts \
  src/lib/fiscal/emision.integration.test.ts
```

- [ ] **Step 2: Make association explicit throughout the engine**

Do not infer “internal note” from a null `afip_cbte_asoc_id` once period fields exist. Replace broad conditions such as “every NC must use original” with a discriminated association prepared from the exact database row. The emission engine may only build:

- v2/none for a `VENTA`;
- v2/receipt for a linked `NOTA_CREDITO`;
- v3/period for a period `NOTA_CREDITO`.

Update `esNotaInterna` call sites in `ventas.index.tsx` and `emision-legacy.server.ts` to include persisted period dates. The new period row remains a fiscal candidate; a true legacy note with neither association remains internal.

- [ ] **Step 3: Extend exact fiscal reading**

Generate the migration:

```bash
supabase migration new lectura_nc_periodo_fiscal
NC_READ_MIGRATION="$(rg --files supabase/migrations | rg 'lectura_nc_periodo_fiscal\.sql$' | sort | tail -1)"
test -n "$NC_READ_MIGRATION"
```

Obtain current definitions after reset:

```bash
docker exec -i supabase_db_local psql -U postgres -d postgres -Atc \
  "select pg_get_functiondef('public.leer_venta_fiscal_exacta(uuid)'::regprocedure);" \
  > /tmp/quimex-leer-venta-fiscal-exacta.sql
```

Recreate it with period/mode/reason/resolution/effects fields and the intended-refund array. Dates must be `YYYY-MM-DD`, numerics must be PostgreSQL-formatted strings, and rows must have deterministic `orden`. Extend the Zod exact schema in `emision.server.ts` to match; unknown/missing keys remain errors.

In the same migration, recreate the latest `cola_fiscal_lectura` and `guardar_receptor_fiscal_desde_venta` definitions from `pg_get_functiondef`:

- every snapshot-presence branch accepts an exact version in `('2','3')` and calls `validar_snapshot_fiscal_persistido` where either is legal;
- manual receiver saving continues to read the same canonical `receptor` shape from either version;
- queue rows expose period/mode/reason/resolution/effects without leaking intended-refund details across branches;
- no historical v2 fallback or RLS/capability check is removed.

- [ ] **Step 4: Build v3 only from exact persisted values**

`crearSnapshot` must dispatch by `preparacion.asociacion.tipo`. For period mode, call `crearSnapshotFiscalV3` with:

- period/mode/reason/resolution from `ventas` exact read;
- receiver just confirmed through the existing padrón path;
- commercial client retained separately from receiver;
- exact items/totals from PostgreSQL;
- identity reserved by the state machine;
- `cbtesAsoc=[]` and `comprobanteOriginalId=null`.

- [ ] **Step 5: Update frozen-context/recovery readers**

Replace `validarSnapshotFiscalV2` with `validarSnapshotFiscalPersistido` only where either version is legal (`cargarContextoArcaCongelado`, reservation loading, request and reconciliation). Keep v2-only validation for an original linked receipt.

- [ ] **Step 6: Pass focused tests and commit**

```bash
supabase db reset
npx vitest run \
  src/lib/fiscal/receptor.test.ts \
  src/lib/fiscal/receptor.server.test.ts \
  src/lib/fiscal/emision.test.ts \
  src/lib/fiscal/emision.server.test.ts \
  src/lib/fiscal/emision.integration.test.ts
bash scripts/test-snapshot-fiscal-v3.sh
npm run typecheck
git add "$NC_READ_MIGRATION" src/lib/fiscal/codigos.ts src/routes/_authenticated/ventas.index.tsx src/lib/fiscal/emision-legacy.server.ts src/lib/fiscal/receptor.ts src/lib/fiscal/receptor.server.ts src/lib/fiscal/receptor.test.ts src/lib/fiscal/receptor.server.test.ts src/lib/fiscal/emision.ts src/lib/fiscal/emision.test.ts src/lib/fiscal/emision.server.ts src/lib/fiscal/emision.server.test.ts src/lib/fiscal/emision.integration.test.ts
git commit -m "feat(fiscal): preparar emisión de notas por período"
```

---

### Task 8: Apply stock and settlement atomically only after CAE

**Files:**

- Create: migration path printed by `supabase migration new efectos_nc_periodo_post_cae`
- Modify: `scripts/test-nota-credito-periodo-fiscal.sh`
- Modify: `scripts/test-venta-fiscal-atomica.sh`

**Interfaces:**

- Owner-only `public.aplicar_efectos_nc_periodo(p_venta_id uuid) RETURNS void`.
- `transicionar_emision_fiscal` calls it from both `APROBAR` and `RECUPERAR_CAE` in the CAE transaction.
- `CANCELAR` moves an untouched pending period NC to commercial `ANULADA` without compensating effects.

- [ ] **Step 1: Add failing lifecycle and idempotency cases**

Extend the integration script to assert separately:

1. after creation, reservation, request start, rejection, correctable error and `RECONCILIAR`: no commercial effects and `estado='PENDIENTE_FISCAL'`;
2. `APROBAR` a return increases each branch stock once and inserts one `DEVOLUCION` per product/reference;
3. `APROBAR` an adjustment leaves stock and stock movements unchanged;
4. reintegro creates negative `venta_pagos`, uses a current/open cash session, enforces available cash for `EFECTIVO`, and changes `caja_esperado` once;
5. account credit inserts exactly one confirmed `CREDITO` for the commercial client, even when the fiscal receiver is another person;
6. both approved modes become `ACTIVA`, set `nc_efectos_aplicados_at`, exact `total_pagado/estado_pago`, CAE and persisted phase;
7. `RECUPERAR_CAE` after a simulated timeout produces the same single effects;
8. replaying approval/recovery or racing two transitions cannot duplicate any movement;
9. a failure applying stock/cash/account credit rolls back CAE persistence and effects together, leaving the row reconcilable rather than half-approved;
10. untouched pending cancellation sets `ANULADA/CANCELADO`, while reserved/requested/approved period NC cancellation is rejected;
11. `anular_venta` cannot treat an approved period NC as an editable/internal document;
12. the linked total-reversal regression remains byte-for-byte in snapshot v2 and commercially unchanged.
13. an employee with base `puede_facturar` but without `puede_emitir_nc_periodo` cannot claim, emit, reconcile or cancel a period NC by calling the transition RPC directly.
14. turning the period flag off blocks creation and any not-yet-started request, but still permits response persistence, reconciliation and CAE recovery after `REQUEST_INICIADO`.

Run:

```bash
bash scripts/test-nota-credito-periodo-fiscal.sh
```

Expected: failures because effects are not wired.

- [ ] **Step 2: Extract the latest transition definition**

```bash
supabase db reset
docker exec -i supabase_db_local psql -U postgres -d postgres -Atc \
  "select pg_get_functiondef('public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)'::regprocedure);" \
  > /tmp/quimex-transicionar-emision-fiscal.sql
```

Generate a new migration and use the extracted body as the only source:

```bash
supabase migration new efectos_nc_periodo_post_cae
NC_EFFECTS_MIGRATION="$(rg --files supabase/migrations | rg 'efectos_nc_periodo_post_cae\.sql$' | sort | tail -1)"
test -n "$NC_EFFECTS_MIGRATION"
```

- [ ] **Step 3: Implement an owner-only, idempotent effects helper**

The helper must:

```sql
SELECT * INTO v_venta
  FROM public.ventas
 WHERE id=p_venta_id
 FOR UPDATE;

IF v_venta.nc_periodo_modalidad IS NULL
   OR v_venta.nc_efectos_aplicados_at IS NOT NULL THEN
  RETURN;
END IF;
```

Then:

- validate complete period metadata and that the persisted v3 snapshot matches the row;
- lock product/stock rows in stable product-id order;
- use persisted item quantities/prices as frozen intent; do not reprice or suppress a return because the product was deactivated after creation;
- for return mode, upsert stock and insert `stock_movimientos(tipo='DEVOLUCION', referencia_id=venta.id, usuario_id=venta.usuario_id)`;
- for adjustment mode, require exactly one null-product item and never touch stock;
- for reintegro, call `caja_sesion_actual`, run `exigir_efectivo` for the cash subtotal, insert one negative `venta_pagos` per planned row with that explicit `caja_sesion_id`, copy the plan row UUID into `cobro_idempotency_key` for a hard unique guard, and set `total_pagado=total`, `estado_pago='PAGADO'`;
- for account credit, call `cc_registrar_por_venta` once, relying on its unique `venta_id`, keep the full amount as a confirmed credit and leave `total_pagado=0`, `estado_pago='PENDIENTE'` because the resolution is ledger credit rather than returned cash;
- set `estado='ACTIVA'` and `nc_efectos_aplicados_at=clock_timestamp()` last.

Do not grant the helper to `authenticated`, `anon`, `PUBLIC` or direct service clients; only the owner transition function calls it.

- [ ] **Step 4: Dispatch snapshot versions in the transition**

In the current `RESERVAR`, persist `snapshot_version` from `public.validar_snapshot_fiscal_persistido(v_snapshot)`, not a hardcoded `2`. In request/recovery checks, compare the attempt version to `v_snapshot->>'version'` and call the dispatcher. Preserve the existing v2-original validation for linked NC.

After locking the sale and before executing any action, require `public.puede_emitir_nc_periodo(v_uid)` when `nc_periodo_modalidad IS NOT NULL`; retain the existing `puede_facturar` rule for every other fiscal row. This is the server barrier even if a stale queue UI exposes an action.

Read the period flag under lock for period rows. Require it for a fresh `RECLAMAR`, `RESERVAR`, `REQUEST_INICIADO` and `REENVIO_VERIFICADO`; allow `RECLAMAR` while the current row is already `RECONCILIAR`, and do not use the flag to block `RESPUESTA_RECIBIDA`, `APROBAR`, `RECONCILIAR`, `RECUPERAR_CAE`, `BLOQUEAR`, `LIBERAR` or safe cancellation. Those actions close or diagnose work that may already exist in ARCA.

Immediately after validating the CAE payload and before returning success in both branches:

```sql
PERFORM public.aplicar_efectos_nc_periodo(p_venta_id);
```

This call and the CAE/state writes must remain in one PostgreSQL transaction.

- [ ] **Step 5: Make cancellation safe**

Extend `CANCELAR` only for a period NC satisfying all of:

```text
afip_estado = SIN_FACTURAR
afip_numero IS NULL
afip_fase IS NULL
afip_intentos = 0
nc_efectos_aplicados_at IS NULL
```

Set `estado='ANULADA'` and `afip_estado='CANCELADO'`; retain planned refund rows as immutable audit intent. All other corrections require fiscal handling.

- [ ] **Step 6: Pass lifecycle, cash and regression tests**

```bash
supabase db reset
bash scripts/test-nota-credito-periodo-fiscal.sh
bash scripts/test-venta-fiscal-atomica.sh
bash scripts/test-fiscal-concurrencia.sh
```

- [ ] **Step 7: Commit atomic post-CAE effects**

```bash
git add "$NC_EFFECTS_MIGRATION" scripts/test-nota-credito-periodo-fiscal.sh scripts/test-venta-fiscal-atomica.sh
git commit -m "feat(fiscal): aplicar efectos de NC después del CAE"
```

---

### Task 9: Expose the strict server action, flag and assignable permission

**Files:**

- Modify: `src/lib/fiscal/feature.server.ts`
- Modify: `src/lib/fiscal/feature.server.test.ts`
- Modify: `src/lib/ventas.functions.ts`
- Modify: `src/lib/ventas.functions.test.ts`
- Modify: `src/lib/fiscal.functions.ts`
- Modify: `src/lib/fiscal.functions.test.ts`
- Modify: `src/lib/fiscal/cola.functions.ts`
- Modify: `src/lib/fiscal/cola.test.ts`
- Modify: `src/lib/usuarios.functions.ts`
- Modify: `src/lib/usuarios.functions.test.ts`
- Modify: `src/hooks/use-current-user.ts`
- Modify: `src/hooks/use-current-user.test.ts`
- Modify: `src/routes/_authenticated/usuarios.tsx`

**Interfaces:**

```ts
export type FlagsFacturacion = {
  facturacion_receptor_v2_enabled: boolean;
  facturacion_legacy_writer_enabled: boolean;
  nota_credito_periodo_enabled: boolean;
};

export const crearNotaCreditoPeriodoFiscal: ServerFn;
export const administrarPuedeEmitirNcPeriodo: ServerFn;
```

- [ ] **Step 1: Write failing flag, server-action and permission tests**

Assert:

- `leerFlagsFacturacion` requires the third boolean and rejects missing/malformed/multiple rows;
- every write reads flags without process cache;
- `crearNotaCreditoPeriodoFiscal` uses the strict domain schema, sends no totals/perceptions to PostgreSQL and calls only the new RPC;
- server result normalization accepts only `{venta_id,numero,es_cta_cte}`;
- period creation is denied when v2 is off, legacy is on, both writers are on, or the period flag is off;
- the old `crearVenta` branch still requires `cbte_asoc_id` for v2 linked NC and never routes a null association into legacy internal creation;
- current-user access returns `puedeEmitirNcPeriodo=true` for admin or an active employee with both columns, false otherwise;
- only admin can call the new capability mutation.
- every existing `FlagsFacturacion` test fixture supplies `nota_credito_periodo_enabled`, without changing ordinary v2/legacy routing.

Run:

```bash
npx vitest run \
  src/lib/fiscal/feature.server.test.ts \
  src/lib/ventas.functions.test.ts \
  src/lib/fiscal.functions.test.ts \
  src/lib/fiscal/cola.test.ts \
  src/lib/usuarios.functions.test.ts \
  src/hooks/use-current-user.test.ts
```

- [ ] **Step 2: Extend authoritative flag reads**

Select exactly:

```text
id,facturacion_receptor_v2_enabled,facturacion_legacy_writer_enabled,nota_credito_periodo_enabled
```

Do not fold the period flag into `decidirEscritorFiscal`; it gates only the new NC route and must not disable ordinary v2 invoicing.

- [ ] **Step 3: Add a dedicated creation facade**

The server action:

1. parses `notaCreditoPeriodoInputSchema`;
2. loads fresh flags and applies all three gates;
3. invokes `crear_nota_credito_periodo_fiscal` with only raw line inputs, settlement intent and idempotency key;
4. maps database/domain errors through `error-usuario.ts`;
5. returns the pending sale identity without starting a duplicate commercial write.

- [ ] **Step 4: Surface effective access and admin toggle**

Extend all explicit profile selects, default objects and tests with `puede_emitir_nc_periodo`. In Users, show “Emitir NC por período” disabled unless base `puede_facturar` is enabled for an employee, and explain that admins have effective access. The server remains authoritative if the UI becomes stale.

- [ ] **Step 5: Pass focused tests and commit**

```bash
npx vitest run \
  src/lib/fiscal/feature.server.test.ts \
  src/lib/ventas.functions.test.ts \
  src/lib/fiscal.functions.test.ts \
  src/lib/fiscal/cola.test.ts \
  src/lib/usuarios.functions.test.ts \
  src/hooks/use-current-user.test.ts
npm run typecheck
git add src/lib/fiscal/feature.server.ts src/lib/fiscal/feature.server.test.ts src/lib/fiscal.functions.ts src/lib/fiscal.functions.test.ts src/lib/fiscal/cola.functions.ts src/lib/fiscal/cola.test.ts src/lib/ventas.functions.ts src/lib/ventas.functions.test.ts src/lib/usuarios.functions.ts src/lib/usuarios.functions.test.ts src/hooks/use-current-user.ts src/hooks/use-current-user.test.ts src/routes/_authenticated/usuarios.tsx
git commit -m "feat(fiscal): exponer permiso y alta de NC por período"
```

---

### Task 10: Build the period-NC editor and integrate the existing fiscal dialog

**Files:**

- Create: `src/lib/nota-credito-periodo-ui.ts`
- Create: `src/lib/nota-credito-periodo-ui.test.ts`
- Create: `src/components/ventas/editor-nota-credito-periodo.tsx`
- Modify: `src/routes/_authenticated/ventas.nueva.tsx`
- Modify: `src/routes/_authenticated/ventas.index.tsx`
- Modify: `src/components/fiscal/dialogo-emision-fiscal.tsx`
- Modify: `src/components/fiscal/dialogo-emision-validacion.ts`
- Modify: `src/components/fiscal/dialogo-emision-validacion.test.ts`
- Modify: `src/components/fiscal/resumen-emision-fiscal.tsx`
- Modify: `src/routes/_authenticated/facturacion.cola.tsx`
- Modify: `src/lib/fiscal/cola.functions.ts`
- Modify: `src/lib/fiscal/cola.test.ts`

**Interfaces:**

```ts
export type CaminoNotaCredito = "REVERSAR_FACTURA" | "ASOCIAR_PERIODO";
export type EntradaResumenEfectosNcPeriodo = {
  modalidad: ModalidadNcPeriodo;
  resolucion: ResolucionNcPeriodo;
  items: readonly { descripcion: string; cantidad: number }[];
  pagos: readonly { formaPago: FormaPagoReintegro; montoCentavos: number }[];
  totalCentavos: number;
  clienteComercial: string;
  receptorFiscal: string;
};
export type ResumenEfectosNcPeriodo = {
  stock: string;
  liquidacion: string[];
  advertenciaTitular: string | null;
};
export function resumenEfectosNcPeriodo(
  input: EntradaResumenEfectosNcPeriodo,
): ResumenEfectosNcPeriodo;
export function camposVisiblesNcPeriodo(
  modalidad: ModalidadNcPeriodo,
): { productos: boolean; concepto: boolean };
export function esVentaVisibleEnListadoComercial(estado: string): boolean;
```

- [ ] **Step 1: Write failing pure UI-state tests**

Cover:

- selecting linked reversal keeps today’s existing locked/inherited form;
- period option is visible/enabled only with v2 + period flag + effective permission;
- switching mode clears incompatible product/concept state;
- switching settlement clears incompatible payment/account-credit state;
- no period dates are prefilled;
- return summary says stock increases only after CAE and lists product quantities;
- adjustment summary says stock is unchanged;
- another fiscal receiver plus account credit shows both receiver and commercial account owner;
- submit cannot proceed without confirmed receptor, exact settlement and review checkbox.
- `PENDIENTE_FISCAL` is hidden from the ordinary commercial list/export while `ACTIVA` is visible.

Run:

```bash
npx vitest run src/lib/nota-credito-periodo-ui.test.ts src/components/fiscal/dialogo-emision-validacion.test.ts
```

- [ ] **Step 2: Build a focused editor component**

Keep the large route from absorbing another state machine. `editor-nota-credito-periodo.tsx` owns:

- period from/to with empty initial values;
- required motive with inline error;
- mode selector and mutually exclusive item editor;
- full reintegro payment editor or full account-credit option;
- positive-magnitude totals and explicit post-CAE effect copy;
- a stable UUID idempotency key generated when the editor mounts and regenerated only after a confirmed creation/cancellation.

- [ ] **Step 3: Integrate without changing linked and legacy flows**

In `ventas.nueva.tsx`, choosing Nota de crédito first asks:

```text
Revertir una factura específica
Sin factura puntual — asociar por período
```

The first path keeps `Venta fiscal que revierte` and the current `anular_venta` behavior. The second calls only `crearNotaCreditoPeriodoFiscal`, then opens or redirects to the existing fiscal queue/dialog for the returned pending row. Do not expose the historical internal-NC route while v2 is enabled.

- [ ] **Step 4: Adapt fiscal confirmation**

For a period NC:

- remove manual A/B selection and show the server-derived predicted/final letter;
- reuse Cliente comercial / Otro receptor and padrón status;
- display period, mode, reason, net, IVA, total and settlement;
- require a confirmation that the period corresponds to the adjusted operations;
- never offer a blind retry while the row is `RECONCILIAR`.

- [ ] **Step 5: Keep pending period notes in the fiscal queue**

Consume the v3 fields exposed by the Task 7 queue migration and do not add a commercial `estado='ACTIVA'` filter to the fiscal queue: a pending period NC belongs there by `afip_estado`. Conversely, exclude `PENDIENTE_FISCAL` from the ordinary sales list/export until CAE activates it, and keep aggregate reports on `estado='ACTIVA'`. Add tests proving both directions.

- [ ] **Step 6: Run component/domain tests and commit**

```bash
npx vitest run \
  src/lib/nota-credito-periodo-ui.test.ts \
  src/components/fiscal/dialogo-emision-validacion.test.ts \
  src/lib/fiscal/cola.test.ts
npm run typecheck
git add src/lib/nota-credito-periodo-ui.ts src/lib/nota-credito-periodo-ui.test.ts src/components/ventas/editor-nota-credito-periodo.tsx src/routes/_authenticated/ventas.nueva.tsx src/routes/_authenticated/ventas.index.tsx src/components/fiscal/dialogo-emision-fiscal.tsx src/components/fiscal/dialogo-emision-validacion.ts src/components/fiscal/dialogo-emision-validacion.test.ts src/components/fiscal/resumen-emision-fiscal.tsx src/routes/_authenticated/facturacion.cola.tsx src/lib/fiscal/cola.functions.ts src/lib/fiscal/cola.test.ts
git commit -m "feat(ui): agregar flujo de NC fiscal por período"
```

---

### Task 11: Add human errors, immutable detail and fiscal PDF metadata

**Files:**

- Modify: `src/lib/fiscal/error-usuario.ts`
- Modify: `src/lib/fiscal/error-usuario.test.ts`
- Modify: `src/lib/fiscal/impresion.ts`
- Modify: `src/lib/fiscal/impresion.test.ts`
- Modify: `src/lib/fiscal/comprobante-pdf.ts`
- Modify: `src/lib/fiscal/comprobante-pdf.test.ts`
- Modify: `src/lib/ventas-proyeccion.ts`
- Modify: `src/components/ventas/dialogo-detalle-venta.tsx`

**Interfaces:**

- New safe codes for period, mode, settlement, permission, unsupported FCE, certificate/configuration, pre-request outage and post-request uncertainty.
- `DatosFiscalesImpresos` accepts `origen: "SNAPSHOT_V2" | "SNAPSHOT_V3"` and exposes period-NC metadata only for v3.

- [ ] **Step 1: Write failing message and print tests**

Assert the exact user strings:

```text
ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.
ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.
```

Also cover inline field paths (`periodo_desde`, `periodo_hasta`, `motivo`, `items`, `pagos`), clear FCE/certificate messages, no raw JSON/Zod/SOAP/SQL leakage, and phase-sensitive classification:

- a definite network failure before `REQUEST_INICIADO` uses the first message;
- any cut/timeout after persisted `REQUEST_INICIADO` transitions to `RECONCILIAR` and uses the second;
- certificate expiration/authorization is configuration, not “ARCA caída”;
- a normal ARCA rejection remains a translated rejection.

For print/detail, assert period formatted `dd/mm/yyyy a dd/mm/yyyy`, mode, reason, commercial client, fiscal receiver, operator, CAE and applied effects.

Run:

```bash
npx vitest run \
  src/lib/fiscal/error-usuario.test.ts \
  src/lib/fiscal/impresion.test.ts \
  src/lib/fiscal/comprobante-pdf.test.ts
```

- [ ] **Step 2: Add typed safe errors and phase-aware handling**

Add codes rather than matching arbitrary database prose. Extend `CODIGO_POR_CAMPO` for period-NC Zod paths. In the engine, select outage copy from persisted phase; once request start is durable, never downgrade uncertainty to a retryable pre-request error.

- [ ] **Step 3: Print v3 fail-closed**

`prepararDatosFiscales` dispatches with `validarSnapshotFiscalPersistido`; v3 output must derive period/mode/reason from the validated snapshot, never live editable columns. Existing v2 and legacy-print behavior remains unchanged. PDF renders:

```text
Período asociado: 01/08/2026 a 15/08/2026
Modalidad: Devolución de productos | Bonificación / ajuste
Motivo: Bonificación comercial acordada
```

- [ ] **Step 4: Make detail reconstruct the audit trail**

Read-only detail shows:

- `ventas.usuario_id`/operator and creation timestamp;
- commercial client versus fiscal receiver;
- period, mode, reason and resolution;
- pending intent before CAE or exact `venta_pagos`/current-account/stock movements after CAE;
- state, phase, CAE, authorization/recovery evidence and `nc_efectos_aplicados_at`.

Do not add edit/delete controls for an approved NC.

Extend `COLUMNAS_VENTA_SEGURAS` and its exact type with only the new non-secret period/mode/reason/resolution/effects fields needed by the approved sales detail. Keep raw fiscal errors and refund-intent payloads out of this projection.

- [ ] **Step 5: Pass focused tests and commit**

```bash
npx vitest run \
  src/lib/fiscal/error-usuario.test.ts \
  src/lib/fiscal/impresion.test.ts \
  src/lib/fiscal/comprobante-pdf.test.ts
npm run typecheck
git add src/lib/fiscal/error-usuario.ts src/lib/fiscal/error-usuario.test.ts src/lib/fiscal/impresion.ts src/lib/fiscal/impresion.test.ts src/lib/fiscal/comprobante-pdf.ts src/lib/fiscal/comprobante-pdf.test.ts src/lib/ventas-proyeccion.ts src/components/ventas/dialogo-detalle-venta.tsx
git commit -m "feat(fiscal): mostrar auditoría y período de la NC"
```

---

### Task 12: Verify browser stories, regenerate contracts and document the rollout gate

**Files:**

- Modify: `e2e/fixtures/fiscal.ts`
- Create: `e2e/nota-credito-periodo.spec.ts`
- Modify: `e2e/nota-credito.spec.ts`
- Modify: `e2e/nota-credito-guardar.spec.ts`
- Modify: `e2e/facturacion-cola.spec.ts`
- Modify: `src/integrations/supabase/types.ts`
- Modify: `docs/facturacion-receptor-fiscal-operacion.md`

**Interfaces:**

- Mock E2E covers both modes, permissions, receiver validation, CAE approval and uncertain recovery.
- Runbook leaves production flag off and defines a manual homologation gate.

- [ ] **Step 1: Write the failing E2E stories**

Create deterministic stories for:

1. unauthorized employee cannot see period mode and direct action receives a human permission error;
2. admin creates product return, validates commercial CUIT via padrón, confirms period/effects, obtains mock CAE, sees stock increase once and PDF metadata;
3. authorized employee creates a one-line adjustment for another fiscal receiver and credits the commercial client without stock movement;
4. exact multi-method reintegro produces one negative payment per method after CAE;
5. invalid dates/reason/settlement show inline human messages without a request;
6. pre-request outage shows the exact “ARCA está caída… Intentá…” copy and no effects;
7. post-request timeout shows “estamos verificando… No vuelvas a emitirla”, removes blind retry and later recovery applies effects once;
8. linked total reversal still requires its original invoice and emits `CbtesAsoc`;
9. period creation flag off removes the option without disrupting ordinary invoicing.

Run the new spec first:

```bash
INVOICING_MOCK_MODE=true npx playwright test e2e/nota-credito-periodo.spec.ts
```

- [ ] **Step 2: Regenerate Supabase types from the fully migrated local database**

Run:

```bash
supabase db reset
supabase gen types typescript --local > /tmp/quimex-supabase-types.ts
diff -u src/integrations/supabase/types.ts /tmp/quimex-supabase-types.ts || true
cp /tmp/quimex-supabase-types.ts src/integrations/supabase/types.ts
```

Review that the new enum values, columns, table and RPC signatures are present and that no unrelated schema disappeared.

- [ ] **Step 3: Run the full automated verification matrix**

```bash
bash scripts/test-nota-credito-periodo-schema.sh
bash scripts/test-snapshot-fiscal-v3.sh
bash scripts/test-nota-credito-periodo-fiscal.sh
bash scripts/test-receptor-fiscal-schema.sh
bash scripts/test-venta-fiscal-atomica.sh
bash scripts/test-fiscal-concurrencia.sh
npm test
npm run typecheck
npm run lint
INVOICING_MOCK_MODE=true npm run build:vercel
INVOICING_MOCK_MODE=true npx playwright test \
  e2e/nota-credito-periodo.spec.ts \
  e2e/nota-credito.spec.ts \
  e2e/nota-credito-guardar.spec.ts \
  e2e/facturacion-cola.spec.ts
git diff --check
```

Expected: all green. Do not substitute a successful build for SQL concurrency or lifecycle tests.

- [ ] **Step 4: Extend the operations runbook**

Document these exact gates in `docs/facturacion-receptor-fiscal-operacion.md`:

- migrations deploy forward-compatible with `nota_credito_periodo_enabled=false`;
- ordinary v2 and linked NC smoke checks;
- one homologation return and one adjustment per relevant issuer/PV;
- A/B for RI issuers and C only where a configured monotributo issuer exists;
- simulated post-request timeout followed by `FECompConsultar` recovery;
- comparison of number, CAE, receiver, amounts and `PeriodoAsoc` in request/consultation/PDF;
- same WSFE certificate and point of sale, with expiry/authorization checked per environment;
- monitoring queries for pending/reconciling/blocked rows and `nc_efectos_aplicados_at` mismatches;
- rollback by turning off only the new flag; never delete approved NCs or rewrite history;
- separate, explicit production approval after homologation.

Include the activation command as documentation, marked **DO NOT RUN DURING IMPLEMENTATION**:

```sql
UPDATE public.settings
   SET nota_credito_periodo_enabled=true
 WHERE id=true;
```

- [ ] **Step 5: Commit the verified, deployable-but-disabled feature**

```bash
git add e2e/fixtures/fiscal.ts e2e/nota-credito-periodo.spec.ts e2e/nota-credito.spec.ts e2e/nota-credito-guardar.spec.ts e2e/facturacion-cola.spec.ts src/integrations/supabase/types.ts docs/facturacion-receptor-fiscal-operacion.md
git commit -m "test(fiscal): verificar NC por período y rollout"
```

---

## Manual Homologation Gate — after implementation, before production

This gate is deliberately not part of automated execution and requires the user’s ARCA homologation credentials and explicit authorization to emit test receipts.

- [ ] Confirm the target branch has every automated check above green and no uncommitted changes.
- [ ] Apply migrations to a non-production Supabase environment with the feature flag still `false`.
- [ ] Confirm each issuer’s existing WSFE certificate is current, belongs to that issuer, is enabled for WSFE and matches the homologation point of sale. Do not create a separate `PeriodoAsoc` certificate.
- [ ] Enable the flag only in the homologation environment and initially use an administrator.
- [ ] Emit a product-return NC for each applicable A/B/C issuer configuration.
- [ ] Emit an adjustment NC for each applicable A/B/C issuer configuration.
- [ ] For every receipt, consult it back with `FECompConsultar` and compare CAE, expiry, point, number, receiver, net, IVA, total and both period dates.
- [ ] Simulate a timeout after persisted `REQUEST_INICIADO`; verify that the row enters reconciliation, cannot blind-retry, recovers the CAE and applies effects once.
- [ ] Verify PDF/detail, stock, cash or account credit and audit operator against the approved receipt.
- [ ] Record evidence and obtain explicit production approval.
- [ ] Deploy code/migrations with the production flag off, smoke-test ordinary invoicing, then enable only the new flag for administrators and monitor the first real emissions.

Production is not ready if any real homologation case is missing, a certificate is expired/unauthorized, a query does not return the same period, or an effect occurs before/duplicate after CAE.
