# Receptor fiscal y cola de facturación — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar ventas, cobros/deuda, caja y stock una sola vez; permitir emitir inmediatamente o desde una cola durable a un receptor fiscal distinto del comprador; y mantener numeración, CAE, reintentos, NC/ND, PDF y QR seguros ante concurrencia e incertidumbre de ARCA.

**Architecture:** `ventas` continúa siendo la única fuente comercial y fiscal. Las ventas ordinarias nuevas usan el tipo neutral `VENTA` y nacen atómicamente con `afip_estado='SIN_FACTURAR'`. El servidor confirma un receptor, crea un snapshot fiscal v2 canónico, reclama la fila, reserva el número y persiste cada fase mediante una RPC de transición antes de llamar a ARCA. `receptores_fiscales` sólo guarda favoritos y `emision_fiscal_intentos` sólo audita; ninguna de las dos duplica CAE ni numeración.

**Tech Stack:** PostgreSQL/Supabase CLI, TanStack Start, React 19, TypeScript 5.8, Zod, `@arcasdk/core@2.0.0`, Vitest 4, Playwright 1.62 y Vercel Node.js/Fluid Compute.

**Spec:** `docs/superpowers/specs/2026-08-21-cobro-y-receptor-fiscal-design.md`

## Global Constraints

- Trabajar sólo en el worktree aislado; no descartar ni mezclar cambios ajenos del árbol principal.
- No aplicar migraciones a producción, desplegar, activar el feature flag ni emitir un CAE real durante la implementación automatizada.
- Ejecutar toda prueba fiscal con `INVOICING_MOCK_MODE=true`; fixtures de SOAP únicamente, sin red a ARCA.
- Mantener `ventas.afip_*`, `cae`, `cae_vencimiento` y `afip_snapshot` como única fuente fiscal autoritativa.
- Nunca duplicar venta, pago, deuda, caja o stock al facturar o reintentar.
- Nunca inferir CUIT, CUIL o CDI por longitud: el tipo documental es explícito.
- No permitir downgrade manual de RI/monotributista a B. Para emisor RI: RI/monotributo → A; exento/CF → B.
- Implementar sólo Factura A estándar. No implementar “Pago en CBU informada” ni “Operación sujeta a retención”.
- Una emisión incierta nunca se reintenta a ciegas: pasa a `RECONCILIAR` y compara el payload completo.
- Un CAE aprobado nuevo sin snapshot v2 o QR bloquea la impresión; no convertirlo silenciosamente en documento interno.
- Certificados, claves, tickets y SOAP completos no salen del servidor ni se escriben en logs/tablas de navegador.
- Toda tabla nueva de `public` lleva RLS. Las mutaciones fiscales privilegiadas se ejecutan por firmas RPC exactas, sin `EXECUTE` para `PUBLIC`.
- `profiles.puede_facturar` nace `false`; sólo admin lo cambia. El guard de privilegios debe impedir autoelevación.
- El proyecto usa migraciones imperativas: cada archivo se crea exclusivamente con `supabase migration new`; no inventar timestamps.
- Si cambia una firma RPC, hacer `DROP FUNCTION` de la firma anterior antes de crear la nueva; no dejar overloads ambiguos para PostgREST.
- Cada task sigue RED → GREEN → refactor → pruebas focalizadas → commit local. No hacer push ni reescribir historia publicada.

---

## File Map

### Database and generated contracts

- Migration generated as `*_venta_fiscal_neutra_enum.sql`: adds only `VENTA` to `tipo_comprobante`.
- Migration generated as `*_receptor_fiscal_outbox.sql`: adds fiscal states/control fields, A-standard evidence, feature flag, favorites, attempts, RLS, grants, indexes, backfill and profile permission.
- Migration generated as `*_venta_fiscal_atomica.sql`: replaces commercial RPCs and creates the only fiscal-transition RPC.
- `scripts/test-receptor-fiscal-schema.sh`: schema, RLS, backfill and self-elevation contract.
- `scripts/test-venta-fiscal-atomica.sh`: sale/payment/stock idempotency, transition state machine and note inheritance contract.
- `scripts/test-fiscal-concurrencia.sh`: concurrent claims, reservations and uniqueness contract.
- `src/integrations/supabase/types.ts`: regenerated after all local migrations pass.

### Fiscal domain and ARCA engine

- `src/lib/fiscal/codigos.ts`, `src/lib/fiscal/fecha.ts`, `src/lib/fiscal/fiscal.test.ts`: allowlist, A/B matrix, document/date rules.
- `src/lib/fiscal/receptor.ts`, `src/lib/fiscal/receptor.test.ts`: receiver union, normalization, threshold and validation.
- `src/lib/fiscal/contexto.ts`, `contexto.server.ts`, `contexto.test.ts`: branch/emitter/PV/credential plus A-standard evidence.
- `src/lib/fiscal/config.ts`, `config.functions.ts`, `config.test.ts`: safe admin confirmation and separate A/B sequence probes.
- `src/lib/fiscal/snapshot.ts`, `snapshot.test.ts`: canonical snapshot v2 and SHA-256 hash.
- `src/lib/fiscal/arca.ts`, `arca.test.ts`, `arca-runtime.test.ts`: payload generation and full raw `FECompConsultar` adapter.
- `src/lib/fiscal/reconciliacion.ts`, `reconciliacion.test.ts`: exact snapshot-vs-ARCA comparison and retry decision.
- `src/lib/fiscal/emision.ts`, `emision.test.ts`: deterministic state machine with injected dependencies.
- `src/lib/fiscal/receptor.server.ts`: authorized receiver/favorite lookup and one-off persistence.
- `src/lib/fiscal/permiso.server.ts`: server-side admin/capability/branch checks.
- `src/lib/fiscal/feature.server.ts`: authoritative feature-flag read shared by routes and writers.
- `src/lib/fiscal/emision-legacy.server.ts`: temporary old writer, callable only while the v2 flag is off and removed after drain.
- `src/lib/fiscal.functions.ts`: thin server-action facade; no direct fiscal updates to `ventas`.
- `src/lib/fiscal/impresion.ts`, `impresion.test.ts`: fail-closed snapshot/QR preparation.
- `src/lib/fiscal/qr.ts`, `comprobante-pdf.ts`, `comprobante-pdf.test.ts`: legal date, receiver and legends.

### Queue, permissions and UI

- `src/lib/fiscal/cola.functions.ts`, `cola.test.ts`: server pagination, counts, favorites and queue actions.
- `src/lib/fiscal/cola-ui.ts`, `cola-ui.test.ts`: pure tab/state/action mapping.
- `src/lib/ventas-ui.ts`, `ventas-ui.test.ts`: close-action mapping by document type and capability.
- `src/hooks/use-current-user.ts`, `src/lib/secciones.ts`, `src/lib/secciones.test.ts`, `src/lib/usuarios.functions.ts`: effective `puedeFacturar` and protected admin mutation.
- `src/routes/_authenticated/facturacion.tsx`: nested layout.
- `src/routes/_authenticated/facturacion.index.tsx`: redirects to the queue.
- `src/routes/_authenticated/facturacion.cola.tsx`: fiscal-capability route.
- `src/routes/_authenticated/facturacion.configuracion.tsx`: admin-only ARCA configuration.
- `src/components/fiscal/dialogo-emision-fiscal.tsx`: shared emission dialog.
- `src/components/fiscal/receptor-fiscal-form.tsx`: commercial/favorite/manual receiver form.
- `src/components/fiscal/resumen-emision-fiscal.tsx`, `estado-fiscal-pill.tsx`: frozen summary and state/validity labels.
- `src/components/fiscal/cola-fiscal-filtros.tsx`, `cola-fiscal-tabla.tsx`: server-backed queue.
- `src/components/ventas/editor-pagos.tsx`, `resumen-cierre-venta.tsx`, `dialogo-detalle-venta.tsx`: shared sale/payment/detail UI.
- `src/components/presupuestos/dialogo-convertir-presupuesto.tsx`: neutral conversion using the same payment/editor flow.
- `src/routes/_authenticated/ventas.nueva.tsx`, `ventas.index.tsx`, `presupuestos.$id.tsx`, `usuarios.tsx`, `_authenticated/route.tsx`: integrate the new flow.
- `e2e/venta-fiscal.spec.ts`, `facturacion-cola.spec.ts`, `presupuestos-facturacion.spec.ts`: main browser stories.
- Existing E2E/scripts listed in Task 13: route and neutral-sale regressions.

---

### Task 1: Establish the baseline and add the neutral `VENTA` enum safely

**Files:**

- Create: migration path printed by `supabase migration new venta_fiscal_neutra_enum`
- Modify: none outside the generated migration

**Interfaces:**

- Produces `public.tipo_comprobante` value `VENTA` in a transaction separate from every statement that uses it.
- Does not change any writer or row yet.

- [ ] **Step 1: Refresh the Supabase implementation baseline before touching migrations**

Run:

```bash
curl -fsSL https://supabase.com/changelog.md -o /tmp/quimex-supabase-changelog.md
rg -n "breaking-change|Postgres|RLS|migration|PostgREST" /tmp/quimex-supabase-changelog.md | head -80
supabase --version
npm test
npm run typecheck
INVOICING_MOCK_MODE=true npm run build:vercel
```

Expected: the current suite, typecheck and Vercel build establish a green baseline. Record any pre-existing failure before continuing; do not “fix” unrelated failures inside this feature.

- [ ] **Step 2: Create the enum migration with the CLI**

Run:

```bash
supabase migration new venta_fiscal_neutra_enum
ENUM_MIGRATION="$(rg --files supabase/migrations | rg 'venta_fiscal_neutra_enum\.sql$' | sort | tail -1)"
test -n "$ENUM_MIGRATION"
echo "$ENUM_MIGRATION"
```

Expected: one empty generated migration path.

- [ ] **Step 3: Write the enum migration**

Use only:

```sql
ALTER TYPE public.tipo_comprobante ADD VALUE IF NOT EXISTS 'VENTA';
```

Do not reference `VENTA` elsewhere in this migration.

- [ ] **Step 4: Reset the local database and prove the value exists**

Run:

```bash
supabase db reset
docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc \
  "select exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='tipo_comprobante' and e.enumlabel='VENTA');"
```

Expected: `t`.

- [ ] **Step 5: Commit the isolated enum migration**

```bash
git add "$ENUM_MIGRATION"
git commit -m "feat(fiscal): agregar tipo neutral de venta"
```

---

### Task 2: Add fiscal state, permissions, favorites, attempts and safe backfill

**Files:**

- Create: `scripts/test-receptor-fiscal-schema.sh`
- Create: migration path printed by `supabase migration new receptor_fiscal_outbox`

**Interfaces:**

- Extends `ventas` with the state/claim/snapshot/error/validity fields from the approved spec.
- Adds `profiles.puede_facturar`, `receptores_fiscales`, `emision_fiscal_intentos` and emitter A-standard evidence.
- Produces helper `public.puede_facturar(_uid uuid DEFAULT auth.uid())`.
- Keeps legacy states readable during coexistence.

- [ ] **Step 1: Create the migration and failing schema contract**

Run:

```bash
supabase migration new receptor_fiscal_outbox
SCHEMA_MIGRATION="$(rg --files supabase/migrations | rg 'receptor_fiscal_outbox\.sql$' | sort | tail -1)"
test -n "$SCHEMA_MIGRATION"
```

Use `apply_patch` to create `scripts/test-receptor-fiscal-schema.sh`, then run `chmod +x scripts/test-receptor-fiscal-schema.sh`. Follow the existing `docker exec ... psql -v ON_ERROR_STOP=1` pattern. It must assert:

```text
VENTA exists
ventas has every new afip_* field
the new state CHECK accepts legacy and new states but rejects garbage
receptores_fiscales and emision_fiscal_intentos have RLS enabled
anon/authenticated have no rights on emision_fiscal_intentos
an employee sees favorite rows only from their active branch and only with fiscal capability
profiles.puede_facturar defaults false
an authenticated user cannot set their own puede_facturar=true
admin can set it through the dedicated server/RPC path
public cannot execute fiscal transition functions
queue and favorite indexes exist
backfill classification matches fixtures without requesting CAE
```

- [ ] **Step 2: Run the contract RED**

```bash
./scripts/test-receptor-fiscal-schema.sh
```

Expected: FAIL at the first missing column/table.

- [ ] **Step 3: Implement additive columns and constraints**

The migration must add:

```sql
ALTER TABLE public.profiles
  ADD COLUMN puede_facturar boolean NOT NULL DEFAULT false;

ALTER TABLE public.emisores
  ADD COLUMN factura_a_modalidad text NOT NULL DEFAULT 'DESCONOCIDA',
  ADD COLUMN factura_a_confirmada_at timestamptz,
  ADD COLUMN factura_a_confirmada_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN factura_a_revalidar_at date,
  ADD COLUMN factura_a_evidencia text;

ALTER TABLE public.ventas
  ADD COLUMN afip_fecha_comprobante date,
  ADD COLUMN afip_snapshot_hash text,
  ADD COLUMN afip_claim_token uuid,
  ADD COLUMN afip_claimed_at timestamptz,
  ADD COLUMN afip_fase text,
  ADD COLUMN afip_error_clase text,
  ADD COLUMN afip_error_codigo text,
  ADD COLUMN afip_error_fase text,
  ADD COLUMN afip_ultimo_error_at timestamptz,
  ADD COLUMN afip_validez text,
  ADD COLUMN afip_legacy_incompleto boolean NOT NULL DEFAULT false,
  ADD COLUMN afip_version integer NOT NULL DEFAULT 0;
```

Replace the old `afip_estado` CHECK by name and constrain the compatibility set:

```text
NO_APLICA, PENDIENTE, ERROR,
SIN_FACTURAR, EMITIENDO, APROBADO, ERROR_CORREGIBLE,
RECONCILIAR, CANCELADO, BLOQUEADO
```

Add named checks for:

- `afip_fase` in `PREFLIGHT|RESERVADO|REQUEST_INICIADO|RESPUESTA_RECIBIDA|PERSISTIDO` or null;
- `afip_validez` in `PRODUCCION|HOMOLOGACION|SIMULADA` or null;
- A modality in `DESCONOCIDA|ESTANDAR_CONFIRMADA|NO_SOPORTADA`;
- `APROBADO` requires CAE/number; `CANCELADO` forbids CAE; new `RECONCILIAR` requires number/snapshot/hash, while incomplete legacy reservations must be `BLOQUEADO`;
- number/claim/snapshot coherence without pretending that incomplete legacy rows are complete.

- [ ] **Step 4: Add auxiliary tables with RLS and exact grants**

Create `public.receptores_fiscales` with the spec fields, a canonical document check and indexes on `(sucursal_id, activo, razon_social)` and `(tipo_documento, numero_documento)`.

Create `public.emision_fiscal_intentos` with:

```text
id, venta_id, claim_token, snapshot_version, payload_hash,
fase, resultado, numero_reservado, error_clase, error_codigo,
respuesta_resumen jsonb, created_at, updated_at
```

Add `UNIQUE (venta_id, claim_token)` so the state machine can safely upsert one attempt per claim; test duplicate concurrent insertion.

Security requirements:

```sql
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.emision_fiscal_intentos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.emision_fiscal_intentos TO service_role;
```

Favorite policies must use the active branch, fiscal capability and authenticated creator, not client-supplied branch IDs. Admin can read/manage all rows. A capable employee may read active favorites in their active branch; insert must force `sucursal_id=current_sucursal_id()` and `creado_por=auth.uid()`; update/deactivation is limited to that creator and branch. `SIN_IDENTIFICAR` cannot be inserted as a favorite. Editing a favorite never touches a sale snapshot.

- [ ] **Step 5: Extend the existing profile privilege guard and helper**

Replace the latest `guard_profiles_columnas` body from `20260813120000_multi_sucursal_empleados.sql`, preserving all prior protected fields and adding:

```sql
IF NEW.puede_facturar IS DISTINCT FROM OLD.puede_facturar THEN
  RAISE EXCEPTION 'No puede modificar el permiso fiscal de su propio perfil';
END IF;
```

Create `public.puede_facturar(_uid uuid DEFAULT auth.uid()) RETURNS boolean` as `SECURITY INVOKER`, returning `is_admin(_uid) OR (profiles.activo AND profiles.puede_facturar)`. Revoke `PUBLIC`; grant only `authenticated, service_role` on the exact signature.

- [ ] **Step 6: Define, but do not run, the gated backfill without inventing fiscal history**

Create a locked-down `public.backfill_cola_fiscal(p_aplicar boolean DEFAULT false)` routine with no grant to `PUBLIC`, `anon` or `authenticated`. With `p_aplicar=false` it returns classification counts without mutation; with `true` it applies the same classified set atomically. It classifies existing rows exactly:

```text
cae present                                  -> APROBADO
number present, no cae, complete v2/hash     -> RECONCILIAR
number present, incomplete legacy evidence   -> BLOQUEADO + afip_legacy_incompleto
old ERROR without number                     -> ERROR_CORREGIBLE
active A/B/C without number or cae            -> SIN_FACTURAR
annulled without cae                          -> CANCELADO
remito/internal                               -> NO_APLICA
note without valid fiscal association         -> BLOQUEADO
```

Set `afip_validez` from current mode/simulation. Preserve snapshots v1; mark any approved row without a complete v2 snapshot as `afip_legacy_incompleto=true`. Never reconstruct receiver, fiscal date or PV from live client data, and never call ARCA from SQL.

Do **not** call the applying mode from the additive migration. The schema must be deployable while old and new readers coexist. The schema contract may call `backfill_cola_fiscal(true)` only inside a rolled-back local fixture. Task 14 prepares the production migration after the compatible reader is deployed, but applies it only after the legacy writer is fenced and drained.

- [ ] **Step 7: Add feature flag and queue indexes**

Extend the existing settings mechanism with two independent rollout flags:

```text
facturacion_receptor_v2_enabled = false
facturacion_legacy_writer_enabled = true
```

Old UI/writer runs only under the second flag; new neutral UI/writer runs only under the first. Both false is the short fiscal cutover fence; both true is invalid and blocked by a CHECK. Add partial indexes for queue pagination by `(sucursal_id, afip_estado, fecha DESC, id)` and attempts by `(venta_id, created_at DESC)`. Preserve the current unique fiscal index including emitter CUIT/PV/type/number/mode/simulation.

- [ ] **Step 8: Run schema tests and Supabase advisors locally**

```bash
supabase db reset
./scripts/test-receptor-fiscal-schema.sh
supabase db lint --level warning
```

Expected: all contract assertions pass; no missing RLS or ambiguous function warnings.

- [ ] **Step 9: Commit schema/security**

```bash
git add "$SCHEMA_MIGRATION" scripts/test-receptor-fiscal-schema.sh
git commit -m "feat(fiscal): agregar cola y receptor fiscal seguro"
```

---

### Task 3: Implement the database state machine and concurrency boundary

**Files:**

- Create: `scripts/test-fiscal-concurrencia.sh`
- Create: migration path printed by `supabase migration new maquina_estados_emision_fiscal`

**Interfaces:**

- Produces the only fiscal writer:

```sql
public.transicionar_emision_fiscal(
  p_venta_id uuid,
  p_accion text,
  p_claim_token uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  venta_id uuid,
  afip_estado text,
  afip_fase text,
  afip_claim_token uuid,
  afip_numero integer,
  afip_version integer
)
```

- Accepted actions are exactly `RECLAMAR`, `RESERVAR`, `REQUEST_INICIADO`, `RESPUESTA_RECIBIDA`, `APROBAR`, `ERROR_CORREGIBLE`, `RECONCILIAR`, `REENVIO_VERIFICADO`, `LIBERAR`, `CANCELAR`, `BLOQUEAR`.
- The RPC is `SECURITY INVOKER`, callable only by `service_role`; browser users never receive direct fiscal write access.

- [ ] **Step 1: Create the migration and write concurrent RED tests**

```bash
supabase migration new maquina_estados_emision_fiscal
STATE_MIGRATION="$(rg --files supabase/migrations | rg 'maquina_estados_emision_fiscal\.sql$' | sort | tail -1)"
test -n "$STATE_MIGRATION"
```

Use `apply_patch` to create `scripts/test-fiscal-concurrencia.sh`, then run `chmod +x scripts/test-fiscal-concurrencia.sh`. The script must run independent `psql` sessions in parallel and fail until these contracts exist:

1. two `RECLAMAR` actions with different tokens produce exactly one winner;
2. a stale `expected_version` or wrong token affects zero rows and raises;
3. two `RESERVAR` calls for the same CUIT/PV/type cannot create different receivers or duplicate a number;
4. sequences remain independent when CUIT, mode or simulation differs;
5. `REQUEST_INICIADO` is durable before an external call can happen;
6. invalid state/action and unknown payload keys raise;
7. post-reservation receiver, date, amount, emitter, PV and snapshot are immutable;
8. a safe resend rotates the claim but preserves number/date/snapshot/hash exactly;
9. two sequential simulated invoices reserve distinct local numbers without a remote sequence;
10. an authenticated connection cannot call the RPC or directly update fiscal columns.

- [ ] **Step 2: Run the concurrency contract RED**

```bash
./scripts/test-fiscal-concurrencia.sh
```

Expected: FAIL because `transicionar_emision_fiscal` is absent.

- [ ] **Step 3: Implement claim and transition validation**

Every call must:

```text
SET search_path = ''
SELECT the sale FOR UPDATE
validate p_payload keys for the selected action
require p_payload.expected_version to equal ventas.afip_version
validate prior state, phase, token and lease
increment afip_version once
update exactly one sale
upsert/update one emision_fiscal_intentos row per (venta_id, claim_token)
return the authoritative state
```

`RECLAMAR` accepts only a sale in `SIN_FACTURAR` or a retryable `ERROR_CORREGIBLE`, requires a new non-null token and no reserved number, and sets `EMITIENDO/PREFLIGHT`, `afip_claim_token`, `afip_claimed_at` and the attempt row. Every later emission action requires the current token. `CANCELAR` is the only action that accepts a null token, and only when the row has no active claim/request/number.

- [ ] **Step 4: Implement serialized reservation**

`RESERVAR` payload must allow exactly:

```json
{
  "expected_version": 1,
  "snapshot": {},
  "snapshot_hash": "sha256-hex",
  "numero_propuesto": 1,
  "fecha_comprobante": "YYYY-MM-DD",
  "emisor_cuit": "30714199664",
  "punto_venta": 5,
  "cbte_tipo": 1,
  "modo": "PRODUCCION",
  "simulado": false,
  "validez": "PRODUCCION",
  "ultimo_remoto": 0,
  "ultimo_local_observado": 0
}
```

Inside the transaction:

1. acquire `pg_advisory_xact_lock` from canonical CUIT/PV/type/mode/simulation;
2. compare `ultimo_remoto` and `ultimo_local_observado` with the maximum local reserved/approved number;
3. in a real ARCA sequence, require `numero_propuesto === ultimo_remoto + 1` and reject local-ahead into reconciliation rather than guessing;
4. in `SIMULADA` validity, require `numero_propuesto === max_local + 1` and never depend on mock `ultimoAutorizado() === 0`;
5. require `snapshot.identidad.numero === numero_propuesto`, `snapshot.hash === snapshot_hash` and recompute the same canonical SHA-256 inside the reservation boundary;
6. persist number, snapshot, hash, date and fiscal identity atomically;
7. set phase `RESERVADO` before returning.

Add an internal, ungranted `public.fiscal_snapshot_hash(jsonb)` helper using recursive canonical JSON serialization plus `pgcrypto.digest`, and a parity fixture shared with `snapshot.test.ts`. The remote SOAP lookup happens outside SQL and before this short transaction. If another process reserves in between, the second call sees changed local state and reruns preflight; no lock is held during SOAP.

- [ ] **Step 5: Implement request/result/error actions**

- `REQUEST_INICIADO`: allowed keys `expected_version`; only from `RESERVADO`; persist phase before `FECAESolicitar`.
- `RESPUESTA_RECIBIDA`: allowed keys `expected_version,respuesta_resumen`; only with same token; store a masked summary, never raw SOAP.
- `APROBAR`: allowed keys `expected_version,cae,cae_vencimiento,emitido_at`; requires number, v2 snapshot/hash, fiscal date and exact token; set `PERSISTIDO/APROBADO`.
- `RECONCILIAR`: allowed keys `expected_version,error_clase,error_codigo,error_fase,mensaje_mascarado`; preserve number, snapshot, hash, date, token and attempt evidence.
- `REENVIO_VERIFICADO`: allowed keys `expected_version,nuevo_claim_token,ultimo_remoto,respuesta_resumen,payload_hash`; only from `RECONCILIAR` after persisted explicit ARCA absence, `ultimo_remoto = numero - 1` and identical hash. Rotate to a new claim/attempt, keep identity unchanged and return to `EMITIENDO/RESERVADO` so the normal `REQUEST_INICIADO` transition can run.
- `ERROR_CORREGIBLE`: allowed keys `expected_version,error_clase,error_codigo,error_fase,mensaje_mascarado,liberar_identidad`; only a confirmed rejection or pre-request failure may clear reserved identity; keep the attempt audit.
- `LIBERAR`: allowed keys `expected_version,verificacion`; only an expired claim verified from the attempt log as never sent; forbidden at or after `REQUEST_INICIADO`.
- `CANCELAR`: allowed key `expected_version`; forbidden with CAE, uncertainty or active request.
- `BLOQUEAR`: allowed keys `expected_version,error_clase,error_codigo,error_fase,mensaje_mascarado,diferencias`; preserve all evidence and require admin review.

`RECLAMAR` accepts only `expected_version,lease_segundos`; `RESERVAR` accepts only the keys shown in Step 4. Every action rejects missing required keys and any unknown key.

- [ ] **Step 6: Lock down grants and direct columns**

Use exact grants:

```sql
REVOKE ALL ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transicionar_emision_fiscal(uuid,text,uuid,jsonb)
  TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.emision_fiscal_intentos FROM anon, authenticated;
REVOKE UPDATE ON public.ventas FROM authenticated;
```

Replace the latest `guard_ventas_columnas()` from `20260810140000_comprobante_fiscal_impreso.sql`, preserving previous protections and adding all new fiscal columns. The transition RPC uses service role; no browser bypass exists.

- [ ] **Step 7: Run state/concurrency tests**

```bash
supabase db reset
./scripts/test-receptor-fiscal-schema.sh
./scripts/test-fiscal-concurrencia.sh
```

Expected: one claim wins, reservations are serialized, invalid transitions fail and grants are exact.

- [ ] **Step 8: Commit the database state machine**

```bash
git add "$STATE_MIGRATION" scripts/test-fiscal-concurrencia.sh
git commit -m "feat(fiscal): serializar emisión y conciliación"
```

---

### Task 4: Make neutral sale creation, budget conversion and cancellation atomic

**Files:**

- Create: `scripts/test-venta-fiscal-atomica.sh`
- Create: migration path printed by `supabase migration new venta_fiscal_atomica`

**Interfaces:**

- Keeps the current exact `crear_venta(uuid,uuid,tipo_comprobante,condicion_venta,jsonb,jsonb,numeric,text,text,timestamptz,uuid,uuid)` signature.
- Adds `VENTA` to `next_comprobante_numero` with an internal `VTA` label.
- Produces zero-downtime `convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)`; the legacy conversion remains only during the compatibility window.
- `anular_venta(uuid)` remains the authenticated, branch-validating transactional entry point and invokes the owner-only fiscal transition internally.

- [ ] **Step 1: Create the migration and failing atomic-sale test**

```bash
supabase migration new venta_fiscal_atomica
SALE_MIGRATION="$(rg --files supabase/migrations | rg 'venta_fiscal_atomica\.sql$' | sort | tail -1)"
test -n "$SALE_MIGRATION"
```

Use `apply_patch` to create `scripts/test-venta-fiscal-atomica.sh`, then run `chmod +x scripts/test-venta-fiscal-atomica.sh`. The test must snapshot counts/sums from `ventas`, `venta_items`, `venta_pagos`, stock movements, caja and current account, then assert:

```text
creating VENTA writes every commercial effect once and SIN_FACTURAR in one transaction
an injected failure before queue state rolls back every commercial effect
same idempotency key returns same sale and repairs/ensures SIN_FACTURAR
replay during EMITIENDO returns the same sale without changing state/token/version
facturing/retrying/collecting never changes item, stock or original payment counts
partial and CTA_CTE sales can be factured before or after later collection
neutral budget conversion creates exactly one sale and one set of effects
fiscal failure never changes presupuesto=CONVERTIDO or duplicates conversion
cancellation is blocked during EMITIENDO/RECONCILIAR
sale without CAE cancels fiscal intent without creating a note
approved production sale creates one pending NC inheriting original fiscal identity
```

- [ ] **Step 2: Run the atomic-sale test RED**

```bash
./scripts/test-venta-fiscal-atomica.sh
```

Expected: FAIL because `crear_venta` does not yet recognize `VENTA`.

- [ ] **Step 3: Replace the latest `next_comprobante_numero` and `crear_venta` bodies**

Copy forward the complete latest implementations, not an older migration fragment:

- `next_comprobante_numero`: `20260713130000_auditoria_correcciones.sql`;
- `crear_venta`: `20260813130000_nota_credito_sin_factura.sql`.

Changes only:

- `VENTA` uses the normal positive-sale validation and prefix `VTA`;
- `VENTA` is accepted only while `facturacion_receptor_v2_enabled=true`; database tests switch to v2-only mode inside their fixture transaction;
- its insert explicitly sets `afip_estado='SIN_FACTURAR'`;
- positive legacy `FACTURA_A/B/C` creation is accepted only while `facturacion_legacy_writer_enabled=true`; during the cutover fence it raises before any commercial effect;
- the idempotent fast path locks the existing row and repairs to `SIN_FACTURAR` only a legacy/uninitialized neutral row with no CAE, number, claim, phase, snapshot or hash; it never resets `EMITIENDO`, `RECONCILIAR`, `APROBADO`, `BLOQUEADO` or any active token/version;
- remitos/internals stay `NO_APLICA`; notes retain their association rules;
- stock, payments, caja, debt and product locking remain byte-for-byte equivalent unless a test requires a deliberate fix.

- [ ] **Step 4: Add a neutral budget RPC without an ambiguous overload**

Create a differently named compatibility RPC:

```sql
public.convertir_presupuesto_en_venta_neutral(
  p_presupuesto_id uuid,
  p_cliente_id uuid,
  p_condicion_venta public.condicion_venta,
  p_pagos jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS TABLE(venta_id uuid, numero text, es_cta_cte boolean)
```

Copy the latest behavior from `20260729230000_contado_admite_parcial.sql`, but always call `crear_venta(..., 'VENTA', ...)`. Preserve the conversion lock and idempotency key. Revoke `PUBLIC`; grant the exact new signature to `authenticated, service_role`. Do not add a same-name overload with defaults.

- [ ] **Step 5: Make cancellation respect fiscal uncertainty**

Copy the complete latest `anular_venta` semantics from `20260813130000_nota_credito_sin_factura.sql`, keep its `auth.uid()` and branch authorization, change it to `SET search_path=''` with fully qualified names, and add:

- row lock before any decision;
- reject `EMITIENDO` or `RECONCILIAR`;
- without CAE/uncertainty, cancel the intent and commercial sale atomically;
- with production CAE, create one NC row that points to the original and can only emit with `{ origen:'COMPROBANTE_ORIGINAL' }`;
- block production note against homologation/simulation or legacy-incomplete original;
- preserve positive ARCA amounts and prevent accumulated in-flight/approved NC beyond original total.

For the no-CAE path, call `transicionar_emision_fiscal(..., 'CANCELAR', ...)` from inside this `SECURITY DEFINER` function instead of directly writing fiscal fields. The function owner can invoke the locked-down transition while the external caller still cannot. Keep `anularVenta` on the authenticated Supabase client so `auth.uid()` remains the real operator; do not switch it to a service-role call, which would erase that identity.

- [ ] **Step 6: Prove later collections are fiscally inert**

Keep the signature of `cobrar_saldo_venta` from `20260804120000_caja_no_negativa_y_cobro_de_saldos.sql`. Add SQL assertions that collection changes only payment/saldo/caja/current account and leaves snapshot, hash, fiscal total/date/state/CAE untouched in `SIN_FACTURAR`, `ERROR_CORREGIBLE`, `RECONCILIAR` and `APROBADO`.

- [ ] **Step 7: Run database regression suite**

```bash
supabase db reset
./scripts/test-receptor-fiscal-schema.sh
./scripts/test-fiscal-concurrencia.sh
./scripts/test-venta-fiscal-atomica.sh
./scripts/test-facturacion-multiemisor.sh
./scripts/test-venta-contado.sh
./scripts/test-nota-credito-sin-factura.sh
./scripts/test-caja-y-saldos.sh
```

Expected: all new and existing database contracts pass.

- [ ] **Step 8: Regenerate database types before TypeScript consumes the new schema**

```bash
supabase gen types typescript --local > src/integrations/supabase/types.ts
npm run typecheck
```

Expected: generated types include `VENTA`, fiscal fields/tables, `transicionar_emision_fiscal` and the neutral budget RPC. Do not hand-edit the generated file. Repeat generation in any later task that adds a read RPC.

- [ ] **Step 9: Commit neutral commercial writes**

```bash
git add "$SALE_MIGRATION" scripts/test-venta-fiscal-atomica.sh \
  src/integrations/supabase/types.ts
git commit -m "feat(ventas): registrar venta neutral en cola fiscal"
```

---

### Task 5: Implement pure receiver, document, A/B and fiscal-date rules

**Files:**

- Create: `src/lib/fiscal/receptor.ts`
- Create: `src/lib/fiscal/receptor.test.ts`
- Modify: `src/lib/fiscal/codigos.ts`
- Modify: `src/lib/fiscal/fecha.ts`
- Modify: `src/lib/fiscal/fiscal.test.ts`

**Interfaces:**

```ts
export type SelectorReceptorFiscal =
  | { origen: "CLIENTE_COMERCIAL" }
  | { origen: "FAVORITO"; receptor_fiscal_id: string }
  | {
      origen: "MANUAL";
      tipo_documento: "CUIT" | "CUIL" | "DNI" | "CDI" | "SIN_IDENTIFICAR";
      numero_documento: string | null;
      razon_social: string;
      condicion_iva: CondicionIva;
      domicilio: string | null;
      guardar_para_proximas: boolean;
      confirma_datos_manuales: true;
    }
  | { origen: "COMPROBANTE_ORIGINAL" };

export type ReceptorFiscalConfirmado = {
  razonSocial: string;
  domicilio: string | null;
  tipoDocumento: "CUIT" | "CUIL" | "DNI" | "CDI" | "SIN_IDENTIFICAR";
  numeroDocumento: string | null;
  docTipoArca: 80 | 86 | 87 | 96 | 99;
  docNroArca: string;
  condicionIva: CondicionIva;
  origen: "CLIENTE_COMERCIAL" | "FAVORITO" | "MANUAL" | "ARCA";
  origenId: string | null;
  verificadoArcaAt: string | null;
};
```

- [ ] **Step 1: Write RED tests for receiver mapping and threshold**

Test:

- CUIT/CUIL/CDI/DNI/SIN_IDENTIFICAR → 80/86/87/96/99;
- eleven digits never infer the type;
- CUIT uses the existing canonical CUIT validator; CUIL/CDI/DNI use explicit digit rules;
- anonymous CF below `9_999_999.99` passes; exactly `10_000_000.00` and above fails under the 2026 rule;
- `SIN_IDENTIFICAR` cannot be saved as a favorite;
- manual data require `confirma_datos_manuales=true`.

Run:

```bash
npm test -- src/lib/fiscal/receptor.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Write RED tests for matrix, allowlist and date**

Update `fiscal.test.ts` so it expects:

```text
RI receiver -> A
Monotributo receiver -> A
Exento/Consumidor Final receiver -> B
A always requires a valid CUIT and DocTipo 80
no manual downgrade RI/mono -> B
VENTA is explicitly fiscal; an unknown enum-like string is not
today uses America/Argentina/Cordoba
new fiscal date cannot precede last authorized date
last authorized dated in the future blocks
commercial sale older than five days requires admin confirmation but is not backdated
```

Run:

```bash
npm test -- src/lib/fiscal/fiscal.test.ts
```

Expected: FAIL on the old monotributo and forced-B expectations.

- [ ] **Step 3: Implement the pure rules**

- Replace negative `esComprobanteFiscal` logic with an explicit allowlist containing `VENTA`, historical A/B/C and supported NC/ND.
- `determinarLetra` derives A or B from receiver condition; delete `puedeForzarConsumidorFinal` and every caller.
- `cbteTipoAfip` derives 1/6 only after the neutral sale has a confirmed receiver; note codes derive from the original.
- `letraDeCbteTipo` and document titles throw on unknown codes instead of defaulting to A.
- `fechaFiscalHoyAr`, `validarCorrelatividadFechaFiscal` and `requiereConfirmacionVentaDemorada` are pure and accept an injected clock in tests.

- [ ] **Step 4: Run and commit the pure fiscal domain**

```bash
npm test -- src/lib/fiscal/receptor.test.ts src/lib/fiscal/fiscal.test.ts
git add src/lib/fiscal/receptor.ts src/lib/fiscal/receptor.test.ts \
  src/lib/fiscal/codigos.ts src/lib/fiscal/fecha.ts src/lib/fiscal/fiscal.test.ts
git commit -m "fix(fiscal): derivar receptor y letra con reglas vigentes"
```

---

### Task 6: Gate Factura A on explicit standard-modality evidence

**Files:**

- Modify: `src/lib/fiscal/contexto.ts`
- Modify: `src/lib/fiscal/contexto.server.ts`
- Modify: `src/lib/fiscal/contexto.test.ts`
- Modify: `src/lib/fiscal/config.ts`
- Modify: `src/lib/fiscal/config.functions.ts`
- Modify: `src/lib/fiscal/config.test.ts`
- Modify: `src/components/app/emisores-config.tsx`

**Interfaces:**

```ts
export function validarModalidadFacturaA(
  letra: "A" | "B" | "C",
  modalidad: "DESCONOCIDA" | "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA",
  revalidarAt: string | null,
  ahora?: Date,
): void;
```

`probarConexionAfip` returns separate read-only sequence probes:

```ts
{
  secuencia_b: {
    cbte_tipo: 6;
    ultimo: number;
  }
  secuencia_a: {
    cbte_tipo: 1;
    ultimo: number;
  }
}
```

- [ ] **Step 1: Write failing context/config tests**

Tests must prove:

- A is blocked for `DESCONOCIDA`, `NO_SOPORTADA` and expired evidence;
- current `ESTANDAR_CONFIRMADA` allows A;
- B remains available while A is unknown;
- General Paz resolves only APLI's emitter/PV/credential;
- probing cbte types 1 and 6 does not mark A standard as confirmed;
- an employee never receives evidence-edit controls or credentials.

```bash
npm test -- src/lib/fiscal/contexto.test.ts src/lib/fiscal/config.test.ts
```

Expected: FAIL on missing modality fields and the current B-only probe.

- [ ] **Step 2: Extend the pure/public fiscal context**

Read the emitter fields added in Task 2. The resolved context includes modality and expiration evidence, but public config responses expose no private key, certificate or ticket. Call `validarModalidadFacturaA` only after deriving the receiver letter.

- [ ] **Step 3: Probe A and B sequences without overclaiming**

Change `probarConexionAfip` to run `ultimoAutorizado` for types 6 and 1 and return both results. UI copy must say “Acceso a secuencia A/B”, not “Factura A estándar verificada”. Technical connectivity never updates administrative evidence.

- [ ] **Step 4: Add the explicit admin confirmation action**

In `config.functions.ts`, add an admin-only Zod-validated action that writes:

```text
modalidad = ESTANDAR_CONFIRMADA | NO_SOPORTADA
confirmada_at = server now
confirmada_por = authenticated admin id
fuente/evidencia = required non-empty text
revalidar_at = required date
```

Use the server admin client only after `requireAdmin`. Render the status and evidence form in `EmisoresConfig`; no automatic confirmation and no special A variants.

- [ ] **Step 5: Run and commit modality gating**

```bash
npm test -- src/lib/fiscal/contexto.test.ts src/lib/fiscal/config.test.ts
npm run typecheck
git add src/lib/fiscal/contexto.ts src/lib/fiscal/contexto.server.ts \
  src/lib/fiscal/contexto.test.ts src/lib/fiscal/config.ts \
  src/lib/fiscal/config.functions.ts src/lib/fiscal/config.test.ts \
  src/components/app/emisores-config.tsx
git commit -m "feat(fiscal): confirmar modalidad A estándar por emisor"
```

---

### Task 7: Create a canonical fiscal snapshot v2 and immutable hash

**Files:**

- Modify: `src/lib/fiscal/snapshot.ts`
- Modify: `src/lib/fiscal/snapshot.test.ts`

**Interfaces:**

```ts
export type SnapshotFiscalV2 = {
  version: 2;
  hash: string;
  // complete canonical emitter, branch, receiver, sequence, date, amounts and associations
};

export function crearSnapshotFiscalV2(input: SnapshotFiscalV2Input): SnapshotFiscalV2;
export function serializarSnapshotFiscal(valueWithoutHash: unknown): string;
export function calcularHashSnapshotFiscal(valueWithoutHash: unknown): string;
export function validarSnapshotFiscalV2(value: unknown): SnapshotFiscalV2;
```

- [ ] **Step 1: Replace snapshot tests with v2 RED cases**

Fixtures must include:

```text
sale/items ordered by stable item ID
emitter and branch/PV/mode/validity
receiver with logical and ARCA document/condition
letter/cbte type/concept
reserved number and fiscal date
net/exempt/non-taxed/IVA by aliquot/tributes/total
currency and exchange rate
complete CbtesAsoc for notes
IVA Contenido and Otros Impuestos Nacionales Indirectos separately
```

Assert that key order and equivalent array ordering produce the same serialization/hash; changing receiver, condition, date, number, total or association changes the hash. Decimal values must canonicalize as strings such as `"1210.00"`, never binary float artifacts.

Use one shared fixture against Task 3's `fiscal_snapshot_hash(jsonb)` and require the TypeScript and PostgreSQL hashes to match byte-for-byte. The snapshot candidate includes the proposed reserved number; the reservation RPC validates that number and hash under its advisory lock before persisting either.

```bash
npm test -- src/lib/fiscal/snapshot.test.ts
```

Expected: FAIL because the current snapshot is v1.

- [ ] **Step 2: Implement stable canonical serialization and SHA-256**

Recursively sort object keys and domain arrays by explicit stable keys. Reject `NaN`, `Infinity`, functions, dates without conversion, duplicate item/aliquot IDs and missing required fields. Compute SHA-256 over the object without its `hash`, then set both `snapshot.hash` and database `afip_snapshot_hash` to the same lowercase hex.

- [ ] **Step 3: Validate fail-closed v2 reads**

`validarSnapshotFiscalV2` must verify schema, canonical amount formats and recomputed hash. It may not silently upgrade v1 with live data. Only the printing legacy path explicitly handles `afip_legacy_incompleto=true`.

- [ ] **Step 4: Run and commit snapshot v2**

```bash
npm test -- src/lib/fiscal/snapshot.test.ts
git add src/lib/fiscal/snapshot.ts src/lib/fiscal/snapshot.test.ts
git commit -m "feat(fiscal): congelar snapshot fiscal v2"
```

---

### Task 8: Preserve the full ARCA response and decide reconciliation exactly

**Files:**

- Create: `src/lib/fiscal/arca.test.ts`
- Create: `src/lib/fiscal/reconciliacion.ts`
- Create: `src/lib/fiscal/reconciliacion.test.ts`
- Modify: `src/lib/fiscal/arca.ts`
- Modify: `src/lib/fiscal/arca-runtime.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

```ts
export type ComprobanteArcaConsultado = {
  puntoVenta: number;
  cbteTipo: number;
  numero: number;
  cae: string;
  caeVencimiento: string | null;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
  fecha: string;
  total: string;
  neto: string;
  exento: string;
  noGravado: string;
  iva: string;
  tributosTotal: string;
  moneda: string;
  cotizacion: string;
  alicuotas: Array<{ id: number; base: string; importe: string }>;
  tributos: Array<{ id: number; base: string; alicuota: string; importe: string }>;
  asociados: Array<{
    tipo: number; puntoVenta: number; numero: number; cuit: string; fecha: string | null;
  }>;
};

export function crearPayloadCaeDesdeSnapshot(snapshot: SnapshotFiscalV2): Record<string, unknown>;
export function normalizarComprobanteArca(resultGet: unknown): ComprobanteArcaConsultado;
export async function consultarComprobanteCompleto(...): Promise<ComprobanteArcaConsultado | null>;
```

- [ ] **Step 1: Write raw SOAP adapter RED tests**

Use checked-in inline fixtures, not network. Prove:

- request payload is created only from snapshot and includes `CondicionIVAReceptorId`, `Iva`, `Tributos`, `CbtesAsoc`;
- singleton and array SOAP collections normalize identically;
- missing required remote fields reject reconciliation;
- ARCA “not found” is the only case returning `null`;
- timeouts stay uncertain and definitive rejection codes stay definitive;
- no test asks for CAE or network.

```bash
npm test -- src/lib/fiscal/arca.test.ts src/lib/fiscal/arca-runtime.test.ts
```

Expected: FAIL because `getVoucherInfo` drops required fields.

- [ ] **Step 2: Use the SDK's public generic SOAP service for the full result**

Keep `@arcasdk/core` pinned exactly to `2.0.0`. Encapsulate this call in `arca.ts`:

```ts
const raw = await arca.genericService.call("wsfe", "FECompConsultar", {
  FeCompConsReq: { CbteNro: numero, PtoVta: pv.numero, CbteTipo: cbteTipo },
});
```

Normalize `FECompConsultarResult.ResultGet` without going through the lossy `VoucherInfo` mapper. Preserve the existing `/tmp/quimex-arca-tickets` and Supabase ticket-storage runtime fix. `arca-runtime.test.ts` alarms if `genericService.call` disappears or the SDK version drifts.

Wrap the raw generic call and both sequence/date probes with the existing 25-second `conTimeout` boundary and `esErrorTransitorio` classification. A timeout never becomes “not found”; only ARCA's explicit absence response returns `null`.

- [ ] **Step 3: Write reconciliation RED tests**

`compararSnapshotConArca` must report differences for every header, receiver, concept, date, total, net, exempt, non-taxed, aliquot, IVA, tribute, currency, rate and association field. `decidirConciliacion` returns:

```ts
type DecisionConciliacion =
  | { accion: "RECUPERAR_CAE"; cae: string; vencimiento: string | null }
  | { accion: "REENVIAR_MISMO_NUMERO" }
  | { accion: "BLOQUEAR"; diferencias: string[] };
```

Cases:

- exact remote match → recover CAE;
- any missing/different field → block;
- explicit absence plus `ultimoRemoto === numeroReservado - 1` → resend same number and hash;
- any other sequence jump → block;
- array order alone does not differ.

```bash
npm test -- src/lib/fiscal/reconciliacion.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement and run the adapter/reconciliation suite**

```bash
npm test -- \
  src/lib/fiscal/arca.test.ts \
  src/lib/fiscal/arca-runtime.test.ts \
  src/lib/fiscal/reconciliacion.test.ts
git add src/lib/fiscal/arca.ts src/lib/fiscal/arca.test.ts \
  src/lib/fiscal/arca-runtime.test.ts src/lib/fiscal/reconciliacion.ts \
  src/lib/fiscal/reconciliacion.test.ts package.json bun.lock
git commit -m "feat(fiscal): conciliar respuesta completa de ARCA"
```

---

### Task 9: Replace the monolithic emitter with one deterministic fiscal engine

**Files:**

- Create: `src/lib/fiscal/emision.ts`
- Create: `src/lib/fiscal/emision.test.ts`
- Create: `src/lib/fiscal/emision.integration.test.ts`
- Create: `src/lib/fiscal/receptor.server.ts`
- Create: `src/lib/fiscal/permiso.server.ts`
- Create: `src/lib/fiscal/feature.server.ts`
- Create: `src/lib/fiscal/emision-legacy.server.ts`
- Modify: `src/lib/fiscal.functions.ts`

**Interfaces:**

```ts
export async function ejecutarEmisionFiscal(
  input: {
    ventaId: string;
    receptor: SelectorReceptorFiscal;
    confirmaVentaAntigua: boolean;
  },
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal>;

export async function ejecutarConciliacionFiscal(
  input: { ventaId: string },
  deps: DependenciasEmisionFiscal,
): Promise<ResultadoEmisionFiscal>;
```

Public server actions:

```ts
type PrevisualizarEmisionFiscalInput =
  | { origen: "VENTA_EXISTENTE"; venta_id: string; receptor: SelectorReceptorFiscal }
  | {
      origen: "BORRADOR";
      sucursal_id: string;
      cliente_id: string;
      fecha_comercial: string;
      items: Array<unknown>;
      pagos: Array<unknown>;
      percepciones: number;
      receptor: SelectorReceptorFiscal;
    };

previsualizarEmisionFiscal(input: PrevisualizarEmisionFiscalInput);
emitirComprobante(input: {
  venta_id: string;
  receptor: SelectorReceptorFiscal;
  confirma_venta_antigua: boolean;
});
reconciliarComprobante(input: { venta_id: string }); // admin only
liberarClaimFiscal(input: { venta_id: string }); // admin only and verified never sent
```

During the compatibility deployment, `emitirComprobante` temporarily accepts the legacy input `{ venta_id }` as a discriminated union. With `facturacion_legacy_writer_enabled=true`, only the extracted legacy implementation is callable. With `facturacion_receptor_v2_enabled=true`, only the receiver-confirmed v2 input is callable. With both false, every fiscal writer returns a maintenance response without mutation. The database CHECK forbids both true. Old clients are fenced and drained before v2 is enabled; no input silently crosses from one engine to the other.

- [ ] **Step 1: Write the pure engine RED suite with injected dependencies**

Cover exact transition order:

```text
approved: RECLAMAR -> RESERVAR -> REQUEST_INICIADO -> RESPUESTA_RECIBIDA -> APROBAR
timeout before reserve: ERROR_CORREGIBLE/LIBERAR, zero CAE requests
timeout after REQUEST_INICIADO: RECONCILIAR, never release/reemit blind
definitive rejection: ERROR_CORREGIBLE with audited immutable attempt
failure persisting after CAE: no success response; reconciliation required
two submits/different receivers: one claim and one ARCA call
exact remote reconciliation: recover CAE
different/incomplete remote: BLOQUEAR
safe resend: same number, date, receiver, amounts and hash
two sequential SIMULADA attempts: local numbers 1 and 2 although remote mock reports 0
favorite/emitter edits after reservation: no payload change
NC/ND: only original snapshot receiver/emitter/validity/association
flag off: legacy input reaches only legacy engine; v2 input is rejected
flag on: v2 input reaches only v2 engine; legacy input is rejected after drain
```

```bash
npm test -- src/lib/fiscal/emision.test.ts
```

Expected: FAIL because the engine module does not exist.

- [ ] **Step 2: Implement server authorization and receiver resolution**

`permiso.server.ts` derives authenticated user, admin status, active branch and `puede_facturar`; employees can emit/retry only their active enabled branch. Reconciliation, claim release and confirmation of a sale older than five days require admin. Configuration remains admin-only.

`feature.server.ts` reads both rollout flags on the server for every write. Client visibility is only convenience: the legacy/new/maintenance decision is enforced again inside `fiscal.functions.ts`, `crear_venta` for positive legacy A/B rows, sale-creation UI actions and budget conversion.

`receptor.server.ts` resolves:

- commercial client without changing `ventas.cliente_id`;
- active favorite visible to branch/capability;
- fully validated one-off manual receiver;
- original snapshot for NC/ND.

Saving a manual favorite is opt-in and happens only after its values validate and the user confirms emission for an already-created sale; draft preview never writes a favorite. It does not create/change a commercial client. The snapshot copies values; it never rereads a favorite during retry.

- [ ] **Step 3: Implement preview without claiming or writing**

`previsualizarEmisionFiscal` accepts either an existing sale (queue/budget) or an unsaved draft (immediate close). It returns buyer, resolved receiver, emitter/PV/mode, derived letter/reason, commercial/fiscal date preview, delay warning, total/paid/balance and whether A-standard confirmation permits emission. Draft values are Zod-validated and totals are recomputed with the same server pricing rules as sale creation. It performs no sale, claim, number or favorite mutation.

After the user confirms a draft, commercial creation runs first and the engine recomputes the authoritative preview from the persisted sale. If amount, emitter, PV, letter or receiver differs from what the user confirmed, do not call ARCA: leave the sale `SIN_FACTURAR` and require a new confirmation from the queue.

- [ ] **Step 4: Implement emission as orchestration over the transition RPC**

The engine must:

1. authorize branch/capability;
2. claim the sale once;
3. validate receiver, emitter, A modality, totals and date;
4. query last authorized, its complete last-voucher date and the observed local maximum;
5. derive the proposed number (`remote + 1` for real ARCA, `local + 1` for simulated validity), create snapshot v2/hash containing it;
6. call `RESERVAR` with remote/local observations, proposed number and the candidate snapshot/hash;
7. call `REQUEST_INICIADO` and only then `solicitarCae`;
8. persist response under same token;
9. map every failure according to the phase;
10. never call commercial creation or update `ventas` directly.

Extract the current writer intact into `emision-legacy.server.ts`; it may run only while the legacy flag is on and v2 is off so an already-loaded old client survives the compatibility deployment. The v2 path contains no legacy `EMISION_GRACE_MS`, `camposReescrituraLetra`, `marcarPendiente` or direct fiscal `.update('ventas')`. `fiscal.functions.ts` is a thin authenticated flag/router facade. Task 14 removes the extracted writer only after old instances are fenced/drained and before v2 is enabled.

- [ ] **Step 5: Implement admin reconciliation and verified release**

Reconciliation uses Task 8's full comparison. A matching remote voucher persists recovered CAE; safe absence calls `REENVIO_VERIFICADO`, rotates to a new audited claim and then resends the exact reserved snapshot/number/hash through the normal request phases; divergence blocks. Release is allowed only for an expired pre-request claim with no number and database evidence that `REQUEST_INICIADO` never occurred.

- [ ] **Step 6: Run server and database integration tests**

`emision.integration.test.ts` uses local Supabase/service role for the transition dependency and injected no-network ARCA doubles. It must execute one approved attempt, one post-request timeout, one safe resend and one unknown-key rejection through the real RPC, proving the TypeScript payload adapter matches every SQL allowlist exactly.

```bash
INVOICING_MOCK_MODE=true npm test -- \
  src/lib/fiscal/emision.test.ts \
  src/lib/fiscal/emision.integration.test.ts \
  src/lib/fiscal/receptor.test.ts \
  src/lib/fiscal/reconciliacion.test.ts \
  src/lib/fiscal/snapshot.test.ts
./scripts/test-fiscal-concurrencia.sh
./scripts/test-venta-fiscal-atomica.sh
npm run typecheck
```

Expected: state order and fiscal/commercial separation are green; no real request occurs.

- [ ] **Step 7: Commit the unified engine**

```bash
git add src/lib/fiscal/emision.ts src/lib/fiscal/emision.test.ts \
  src/lib/fiscal/emision.integration.test.ts \
  src/lib/fiscal/receptor.server.ts src/lib/fiscal/permiso.server.ts \
  src/lib/fiscal/feature.server.ts src/lib/fiscal/emision-legacy.server.ts \
  src/lib/fiscal.functions.ts
git commit -m "feat(fiscal): unificar emisión y reintentos seguros"
```

---

### Task 10: Make fiscal PDF and QR depend only on authorized snapshot data

**Files:**

- Create: `src/lib/fiscal/impresion.ts`
- Create: `src/lib/fiscal/impresion.test.ts`
- Modify: `src/lib/fiscal/qr.ts`
- Modify: `src/lib/fiscal/comprobante-pdf.ts`
- Modify: `src/lib/fiscal/comprobante-pdf.test.ts`
- Modify: `src/lib/fiscal.functions.ts`

**Interfaces:**

```ts
export function prepararDatosFiscalesImpresos(input: unknown): DatosFiscalesImpresos;
export function prepararDatosFiscalesLegacyMarcados(input: unknown): DatosFiscalesImpresosLegacy;
export async function qrAfipDataUrlObligatorio(input: QrAfipInput): Promise<string>;
```

- [ ] **Step 1: Add fail-closed RED tests**

Prove:

- commercial buyer Juan + receiver ACME prints ACME only in the fiscal receiver block;
- an old commercial date plus current fiscal date prints the fiscal date;
- Factura/NC/ND A to monotributo prints the exact Ley 27.618 legend;
- transparency renders title, `IVA Contenido` and `Otros Impuestos Nacionales Indirectos` on separate lines with separate amounts;
- CAE plus missing/failed QR throws;
- new `APROBADO` without valid v2 snapshot/hash throws;
- only `afip_legacy_incompleto=true` may use an explicit historical reader and carries a warning;
- homologation/simulation are unmistakably non-legal;
- 1, 20 and 60-item documents remain inside A4.

```bash
npm test -- src/lib/fiscal/impresion.test.ts src/lib/fiscal/comprobante-pdf.test.ts
```

Expected: FAIL on live-data fallback, date, QR and legends.

- [ ] **Step 2: Isolate preparation from rendering**

`prepararDatosFiscalesImpresos` validates snapshot v2/hash, matches CAE/number/date to the sale columns, derives the QR input and returns a render-only value. It never queries a current client, favorite, emitter or branch.

`prepararDatosFiscalesLegacyMarcados` is a separate, visibly warned historical fallback reachable only when `afip_legacy_incompleto=true`. It may use the existing stored/live-data fallback because missing history cannot be invented, but it must label the result as legacy/incomplete and can never run for a new approval. Tests assert the two paths cannot be confused.

- [ ] **Step 3: Make QR mandatory and update legal blocks**

Use `afip_fecha_comprobante`, receiver snapshot, `afip_validez` and the approved CAE. Throw if QR generation fails. Implement the exact monotributo legend and the complete transparency block using the two frozen amounts from snapshot; do not reuse generic tribute totals.

- [ ] **Step 4: Remove silent fallback from server printing**

`datosFiscalesComprobante` fails closed for corrupt new approvals. Keep a typed error that the UI can show. Do not catch it and return `null` for an approved fiscal sale.

- [ ] **Step 5: Run and commit printing compliance**

```bash
npm test -- src/lib/fiscal/impresion.test.ts src/lib/fiscal/comprobante-pdf.test.ts
git add src/lib/fiscal/impresion.ts src/lib/fiscal/impresion.test.ts \
  src/lib/fiscal/qr.ts src/lib/fiscal/comprobante-pdf.ts \
  src/lib/fiscal/comprobante-pdf.test.ts src/lib/fiscal.functions.ts
git commit -m "fix(fiscal): imprimir desde snapshot y exigir QR"
```

---

### Task 11: Expose a safe server-paginated queue and receiver favorites

**Files:**

- Create: `src/lib/fiscal/cola.functions.ts`
- Create: `src/lib/fiscal/cola.test.ts`
- Create: `src/lib/fiscal/cola-ui.ts`
- Create: `src/lib/fiscal/cola-ui.test.ts`

**Interfaces:**

```ts
type ColaFiscalQuery = {
  tab: "pendientes" | "revisar" | "emitidas" | "historial";
  page: number;
  pageSize: number;
  desde?: string;
  hasta?: string;
  sucursal_id?: string;
  emisor_id?: string;
  documento?: string;
  estado?: string;
  venta_id?: string;
};

type ColaFiscalPage = {
  filas: ColaFiscalFila[];
  page: number;
  pageSize: number;
  total: number;
  paginas: number;
  conteos: { pendientes: number; revisar: number; emitidas: number; historial: number };
};
```

- [ ] **Step 1: Write RED tests for tab/action mapping**

`cola-ui.test.ts` must assert:

| State/phase                         | Tab        | Employee action        | Admin action             |
| ----------------------------------- | ---------- | ---------------------- | ------------------------ |
| `SIN_FACTURAR`                      | pendientes | Facturar               | Facturar                 |
| recent `EMITIENDO`                  | pendientes | Procesando             | Procesando               |
| expired pre-request claim           | revisar    | Requiere administrador | Liberar claim verificado |
| expired with number / `RECONCILIAR` | revisar    | Requiere administrador | Verificar con ARCA       |
| `ERROR_CORREGIBLE`                  | revisar    | Corregir/reintentar    | Corregir/reintentar      |
| legacy `PENDIENTE/ERROR`            | revisar    | Requiere administrador | Ver incidente legacy     |
| `BLOQUEADO`                         | revisar    | Requiere administrador | Ver incidente            |
| `APROBADO`                          | emitidas   | Ver/descargar          | Ver/descargar            |
| `CANCELADO`                         | historial  | Ver                    | Ver                      |

```bash
npm test -- src/lib/fiscal/cola-ui.test.ts
```

Expected: FAIL because the mapping module does not exist.

- [ ] **Step 2: Write RED server-query tests**

Use mocked Supabase boundaries plus local database integration to prove:

- Zod rejects page size over 100, unknown states/tabs and invalid dates;
- pagination/counts are performed in the database, not after `.limit(200)`;
- an employee is forced to their active enabled branch even if another branch is supplied;
- admin may filter any branch;
- filters cover dates, branch, emitter, commercial/receptor document, state and exact sale;
- returned fields are an explicit safe projection with no credentials, tickets or raw SOAP;
- favorites require capability and branch visibility; anonymous CF cannot be saved;
- `?venta=<id>` returns/locates that row even when it is older than the default date view.
- legacy `PENDIENTE/ERROR` rows are visible but never emitted by the v2 engine; the gated backfill classifies them before feature activation.

```bash
npm test -- src/lib/fiscal/cola.test.ts
```

Expected: FAIL because the server module does not exist.

- [ ] **Step 3: Implement authenticated server queries**

`listarColaFiscal` authenticates through `permiso.server.ts`, applies the tab's explicit state allowlist and uses `.range(from,to)` plus exact counts. The receiver document is read from snapshot; the commercial document remains a separate joined field. No filter is performed in browser memory.

If PostgREST cannot express the combined document/count query without client-side filtering, add a CLI-generated `cola_fiscal_lectura` migration containing a `SECURITY INVOKER` read RPC with `SET search_path=''`, exact safe return fields, capability check and explicit `authenticated` grant. Do not use a `SECURITY DEFINER` view or expose secrets.

If that migration is created, immediately run `supabase db reset` and `supabase gen types typescript --local > src/integrations/supabase/types.ts` before implementing the TypeScript caller.

- [ ] **Step 4: Implement favorite actions**

Expose `listarReceptoresFiscales`, `guardarReceptorFiscal` and `desactivarReceptorFiscal`. All inputs use the same receiver normalizer as emission. Save `creado_por` and branch from authenticated server context, not input. Desactivation replaces delete. A favorite response contains only reusable identity fields.

- [ ] **Step 5: Run and commit queue services**

```bash
npm test -- src/lib/fiscal/cola.test.ts src/lib/fiscal/cola-ui.test.ts
npm run typecheck
git add src/lib/fiscal/cola.functions.ts src/lib/fiscal/cola.test.ts \
  src/lib/fiscal/cola-ui.ts src/lib/fiscal/cola-ui.test.ts \
  src/integrations/supabase/types.ts
git commit -m "feat(fiscal): exponer cola paginada y receptores"
```

---

### Task 12: Add the fiscal capability, route split and shared queue/dialog UI

**Files:**

- Modify: `src/hooks/use-current-user.ts`
- Modify: `src/lib/secciones.ts`
- Modify: `src/lib/secciones.test.ts`
- Modify: `src/lib/usuarios.functions.ts`
- Modify: `src/routes/_authenticated/route.tsx`
- Modify: `src/routes/_authenticated/usuarios.tsx`
- Modify: `src/routes/_authenticated/facturacion.tsx`
- Create: `src/routes/_authenticated/facturacion.index.tsx`
- Create: `src/routes/_authenticated/facturacion.cola.tsx`
- Create: `src/routes/_authenticated/facturacion.configuracion.tsx`
- Create: `src/components/fiscal/dialogo-emision-fiscal.tsx`
- Create: `src/components/fiscal/receptor-fiscal-form.tsx`
- Create: `src/components/fiscal/resumen-emision-fiscal.tsx`
- Create: `src/components/fiscal/estado-fiscal-pill.tsx`
- Create: `src/components/fiscal/cola-fiscal-filtros.tsx`
- Create: `src/components/fiscal/cola-fiscal-tabla.tsx`
- Generated: `src/routeTree.gen.ts`

**Required sub-skill:** Read and apply `frontend-design:frontend-design` before editing the UI files in this task. Preserve PinturaGest's existing visual language; prioritize dense operational clarity, keyboard behavior and mobile containment.

- [ ] **Step 1: Write permission/navigation RED tests**

Update `secciones.test.ts` to prove:

- employee defaults remain unchanged;
- Facturación is not manually grantable through `secciones`;
- admin always sees queue and configuration;
- admin sees configuration while the flag is off and queue plus configuration when it is on;
- employee with `puedeFacturar=true` sees queue only when the v2 flag is on, never configuration;
- employee without it sees neither;
- an unknown route/capability cannot open access.

Add server-function tests or SQL contract coverage proving a user cannot PATCH their own `puede_facturar`; only the admin `setPuedeFacturar` action can change it.

```bash
npm test -- src/lib/secciones.test.ts
```

Expected: FAIL because `UsuarioPermisos` has no fiscal capability.

- [ ] **Step 2: Implement one effective capability across hook, menu and server**

- `use-current-user.ts` selects `profiles.puede_facturar`, reads both server-backed rollout flags and exposes `puedeFacturar = isAdmin || profileFlag`, `facturacionV2Habilitada` and `facturacionLegacyHabilitada`.
- `Seccion` gains `requiereCapacidad?: 'facturar'`.
- Facturación remains at `/facturacion` and remains excluded from `SECCIONES_OTORGABLES/DEFAULT`. Admin sees it for configuration even with v2 off; an employee sees it only when v2 is on and the fiscal capability is true.
- `_authenticated/route.tsx` passes the same effective capability to menu and guard.
- `usuarios.functions.ts` adds admin-only `setPuedeFacturar({ user_id, value })` using the admin client after `requireAdmin`.
- `usuarios.tsx` shows a separate **Puede facturar** toggle; new employees start false; admin is effectively true and disabled with explanation.

- [ ] **Step 3: Split queue and configuration routes**

- `facturacion.tsx`: nested `<Outlet />`, no global admin guard.
- `facturacion.index.tsx`: admin redirects to configuration while v2 is off and to queue while it is on; fiscal employees can only reach queue while v2 is on.
- `facturacion.cola.tsx`: admin or effective fiscal capability.
- `facturacion.configuracion.tsx`: move current `EmisoresConfig`/`CredencialesArcaConfig`; preserve admin-only guard.
- regenerate route tree with the project's normal build/generator; never edit it by hand.

Add visible layout tabs/actions **Cola** and **Configuración** for admins; employees see only **Cola**. Queue route/links fail closed while v2 is off.

- [ ] **Step 4: Build the shared receiver/emission dialog**

The dialog is the only confirmation surface for immediate emission, queue and converted budget. Ordered content:

1. buyer/debtor read-only;
2. emitter/CUIT/branch/PV/mode read-only;
3. **Facturar a** commercial/favorite/manual;
4. explicit document, legal name, IVA and address for manual;
5. optional **Guardar para próximas facturas**;
6. server-derived letter and reason;
7. commercial/fiscal dates and delay warning;
8. fiscal total, paid and balance;
9. final confirmation.

NC/ND show inherited receiver read-only. While submitting, disable every close/submit path and show **Emitiendo en ARCA…**. Use Radix focus management, initial focus, Escape before submit and focus return. Manual data require an explicit confirmation checkbox.

- [ ] **Step 5: Build the URL-driven queue**

`facturacion.cola.tsx` validates/preserves:

```text
tab, page, desde, hasta, sucursal, emisor, documento, estado, venta, resultado
```

`resultado` is the exact union `venta_creada_factura_pendiente | venta_creada_requiere_revision | factura_aprobada`. It is accepted only with a valid `venta` ID. The first two render the approved “la venta quedó registrada; no repitas venta ni cobro” banner with the authoritative state and action; `requiere_revision` adds **Requiere administrador** when applicable. Closing the banner removes only `resultado` with route replacement, leaving the selected sale/filter intact.

Render server counts and server rows. The table shows document type, Venta V-number, fiscal number, commercial/fiscal dates, buyer and receiver separately, emitter/branch, total/paid/balance, state, validity, urgency and allowed action. Poll only recent `EMITIENDO`; do not hide old pending rows.

- [ ] **Step 6: Run focused tests and commit route/UI foundation**

```bash
npm test -- src/lib/secciones.test.ts src/lib/fiscal/cola-ui.test.ts
npm run typecheck
INVOICING_MOCK_MODE=true npm run build:vercel
git add src/hooks/use-current-user.ts src/lib/secciones.ts src/lib/secciones.test.ts \
  src/lib/usuarios.functions.ts src/routes/_authenticated/route.tsx \
  src/routes/_authenticated/usuarios.tsx src/routes/_authenticated/facturacion.tsx \
  src/routes/_authenticated/facturacion.index.tsx \
  src/routes/_authenticated/facturacion.cola.tsx \
  src/routes/_authenticated/facturacion.configuracion.tsx \
  src/components/fiscal src/routeTree.gen.ts
git commit -m "feat(fiscal): agregar cola y diálogo de emisión"
```

---

### Task 13: Integrate dual sale close, budgets, sale detail and browser stories

**Files:**

- Create: `src/lib/ventas-ui.ts`
- Create: `src/lib/ventas-ui.test.ts`
- Create: `src/components/ventas/editor-pagos.tsx`
- Create: `src/components/ventas/resumen-cierre-venta.tsx`
- Create: `src/components/ventas/dialogo-detalle-venta.tsx`
- Create: `src/components/presupuestos/dialogo-convertir-presupuesto.tsx`
- Modify: `src/routes/_authenticated/ventas.nueva.tsx`
- Modify: `src/routes/_authenticated/ventas.index.tsx`
- Modify: `src/routes/_authenticated/presupuestos.$id.tsx`
- Modify: `src/lib/ventas.functions.ts`
- Modify: `src/lib/format.ts`
- Create: `e2e/venta-fiscal.spec.ts`
- Create: `e2e/facturacion-cola.spec.ts`
- Create: `e2e/presupuestos-facturacion.spec.ts`
- Create: `e2e/fixtures/fiscal.ts`
- Modify: `e2e/usuarios.spec.ts`
- Modify: `e2e/apoyo.ts`
- Modify: `e2e/emisores.spec.ts`
- Modify: `e2e/facturacion-multiemisor.spec.ts`
- Modify: `e2e/dialogos.spec.ts`
- Modify: `e2e/responsive.spec.ts`
- Modify: `e2e/pedidos-may.spec.ts`
- Modify: `scripts/test-venta-contado-e2e.mjs`
- Modify: `scripts/test-presupuesto-e2e.mjs`

- [ ] **Step 1: Write pure close-action RED tests**

`ventas-ui.test.ts` must prove:

- only neutral `VENTA` offers two closes;
- fiscal-capable user sees **Registrar venta y facturar** and **Registrar sin facturar**;
- user without capability sees only **Registrar sin facturar** plus explanation;
- with v2 flag off, the current legacy A/B sale and budget UI remain unchanged for compatibility;
- remitos/internals/NC/ND keep a single save action;
- invoice total is sale total regardless of current payment/balance.

```bash
npm test -- src/lib/ventas-ui.test.ts
```

Expected: FAIL because the module and neutral UI do not exist.

- [ ] **Step 2: Extract shared payment and closing summary**

Move the existing mixed/partial payment editor from `ventas.nueva.tsx` into `EditorPagos` without changing validation. `ResumenCierreVenta` always shows total, paid now, balance and CTA_CTE status plus: **La factura se emite por el total. Facturar no cobra ni cancela el saldo.**

- [ ] **Step 3: Implement the two sale closes**

In `ventas.nueva.tsx`:

- branch first on the two server-backed rollout flags: legacy-only preserves the current form/writer; v2-only defaults ordinary positive sale to `VENTA`; both false shows a fiscal-maintenance notice and disables positive fiscal close without blocking remitos/internals;
- remove prior A/B choice for ordinary sales;
- **Registrar sin facturar** calls `crearVenta` once and never opens receiver UI;
- **Registrar venta y facturar** opens the shared dialog before writing, then on confirmation calls `crearVenta` once followed by `emitirComprobante` for that returned ID;
- the dialog uses the `BORRADOR` preview; after creation the engine revalidates the persisted sale and refuses ARCA if the confirmed summary changed;
- if sale creation fails, show “venta no creada” and keep form;
- if ARCA fails after creation, never retry creation; show the approved partial-result message and `/facturacion/cola?venta=<id>`;
- map the returned authoritative state to `resultado=venta_creada_factura_pendiente` or `venta_creada_requiere_revision`; a success may link with `factura_aprobada`;
- remitos/internals/notes retain their existing single-action paths.

Add `VENTA` to the Zod input in `ventas.functions.ts` and format it as **Venta** in `format.ts`.

- [ ] **Step 4: Convert budgets into the same neutral flow**

Extract `DialogoConvertirPresupuesto`, reuse `EditorPagos`/summary, and when v2 is on remove A/B selection and call `convertir_presupuesto_en_venta_neutral`. In legacy-only mode, preserve the exact legacy conversion RPC/UI for loaded clients. With both flags false, block conversion before mutation and show fiscal maintenance. Offer immediate v2 invoice only with capability. Always retain the returned `venta_id`; an emission failure leaves budget `CONVERTIDO` and links to the same queue row. Do not search the sale by observations.

- [ ] **Step 5: Remove one-click legal emission from the sales list**

In `ventas.index.tsx`:

- with v2 on, replace direct `emitirComprobante({venta_id})` with a link/open to `/facturacion/cola?venta=<id>`; with v2 off preserve the gated legacy action until drain;
- show that link only to an admin or fiscal-capable user while v2 is enabled; the destination guard remains authoritative;
- extract and reuse `DialogoDetalleVenta`;
- show **Venta V-…** separately from **Factura A/B PV-number**;
- show buyer and frozen receiver separately when different;
- use `EstadoFiscalPill`;
- remove `catch { fiscal = null }`; show the typed printing error and abort PDF.

- [ ] **Step 6: Write browser RED stories**

Create `e2e/fixtures/fiscal.ts` as a Node-only helper using the local service role. It seeds named sales for every queue state, more than one page, a different branch, frozen receiver/PDF data and users with/without fiscal capability. Every fixture has a deterministic prefix/idempotency key and `afterAll` cleanup; feature flag and profile permission are restored in `finally` even when a test fails. The helper is never imported by browser bundles.

Add server-only mock scenarios guarded by `NODE_ENV==='test' && INVOICING_MOCK_MODE==='true'`:

```text
OK
RECHAZO_DEFINITIVO
TIMEOUT_POST_REQUEST
QR_ERROR
```

Select them only through `INVOICING_MOCK_SCENARIO` on the Playwright web-server process. No request header, query parameter or production setting may choose a scenario.

`venta-fiscal.spec.ts`:

- two closes only for neutral sale;
- no receiver dialog for “sin facturar”;
- immediate and queue use `[data-testid='dialogo-emision-fiscal']`;
- manual/favorite/commercial receiver, derived letter and invalid combinations;
- total/paid/balance and different buyer/receiver;
- partial result, focus/Escape and double submit.
- fiscal link/action is absent for an employee without capability and destination guard rejects a typed URL.

`facturacion-cola.spec.ts`:

- tabs/counts/filters/pagination from server;
- every state/action mapping;
- validity labels;
- employee branch restriction and no-capability denial;
- admin-only incidents show **Requiere administrador** to employee.

`presupuestos-facturacion.spec.ts`:

- no preselected A/B;
- shared mixed/partial payments;
- one conversion and same sale ID;
- fiscal failure preserves `CONVERTIDO`.

Add browser assertions that a frozen receiver/date appears in the downloaded/previewed fiscal PDF and `QR_ERROR` shows a blocking error rather than an internal-document fallback.

Run RED with mock mode and a local database; expected failures are missing buttons/routes, never network/CAE.

- [ ] **Step 7: Update route/script regressions and make E2E green**

- move emitter/multi-emitter tests to `/facturacion/configuracion`;
- test the fiscal permission toggle and self-elevation rejection;
- add queue/config paths to route inventory;
- update dialogs/responsive tests for the new modal/table;
- update MAY test from “Factura B” default to “Venta”;
- make CLI E2E scripts choose **Registrar sin facturar** and assert `SIN_FACTURAR`;
- enforce `INVOICING_MOCK_MODE=true` in every browser/server test process.

```bash
npm run e2e -- \
  e2e/venta-fiscal.spec.ts \
  e2e/facturacion-cola.spec.ts \
  e2e/presupuestos-facturacion.spec.ts \
  e2e/usuarios.spec.ts \
  e2e/facturacion-multiemisor.spec.ts
INVOICING_MOCK_SCENARIO=TIMEOUT_POST_REQUEST \
  npm run e2e -- e2e/venta-fiscal.spec.ts -g "resultado parcial"
INVOICING_MOCK_SCENARIO=QR_ERROR \
  npm run e2e -- e2e/venta-fiscal.spec.ts -g "bloquea PDF sin QR"
```

Expected: all selected browser stories pass and no request reaches ARCA production.

- [ ] **Step 8: Commit integrated workflows**

```bash
git add src/lib/ventas-ui.ts src/lib/ventas-ui.test.ts \
  src/components/ventas src/components/presupuestos \
  src/routes/_authenticated/ventas.nueva.tsx \
  src/routes/_authenticated/ventas.index.tsx \
  'src/routes/_authenticated/presupuestos.$id.tsx' \
  src/lib/ventas.functions.ts src/lib/format.ts e2e scripts/test-venta-contado-e2e.mjs \
  scripts/test-presupuesto-e2e.mjs
git commit -m "feat(ventas): cobrar y facturar a receptor confirmado"
```

---

### Task 14: Regenerate contracts, perform adversarial verification and prepare gated rollout

**Files:**

- Modify: `src/integrations/supabase/types.ts`
- Create: `docs/facturacion-receptor-fiscal-operacion.md`
- Modify: `docs/facturacion-afip-paso-a-paso.md`
- Create only after the compatibility deployment gate: migration path printed by `supabase migration new backfill_cola_fiscal`
- Create later, after legacy writers are drained: migration path printed by `supabase migration new retirar_escritor_fiscal_legacy`

- [ ] **Step 1: Regenerate Supabase types from the reset local database**

```bash
supabase db reset
supabase gen types typescript --local > src/integrations/supabase/types.ts
npm run typecheck
```

Expected: generated types include `VENTA`, all new columns/tables and exact RPC signatures; typecheck passes without hand-editing generated declarations.

- [ ] **Step 2: Run the complete local database suite**

```bash
supabase db reset
./scripts/crear-admin-local.sh
./scripts/test-receptor-fiscal-schema.sh
./scripts/test-fiscal-concurrencia.sh
./scripts/test-venta-fiscal-atomica.sh
./scripts/test-facturacion-multiemisor.sh
./scripts/test-venta-contado.sh
./scripts/test-nota-credito-sin-factura.sh
./scripts/test-caja-y-saldos.sh
supabase migration list --local
supabase db lint --level warning
```

Expected: clean reset, no ambiguous overload, exact grants/RLS, and all contracts green.

- [ ] **Step 3: Run complete application verification**

```bash
npm test
npm run typecheck
INVOICING_MOCK_MODE=true npm run build:vercel
npm run e2e
```

Expected: unit/integration/E2E/typecheck/build all exit 0. Search artifacts/logs to prove no private key, certificate, ticket or raw SOAP was serialized.

- [ ] **Step 4: Run three adversarial reviews in parallel**

Use independent reviewers for:

1. SQL/RLS/grants/idempotency/backfill;
2. fiscal matrix/snapshot/ARCA reconciliation/NC-PDF-QR compliance;
3. UI permissions, partial-result UX, keyboard/mobile and no double submit.

For every finding: reproduce it, add a failing test, fix minimally, rerun the focused and full suites. Do not accept a review suggestion without verifying it against current code/spec.

- [ ] **Step 5: Write the operator and rollout runbook**

`docs/facturacion-receptor-fiscal-operacion.md` must cover:

- what **Registrar venta y facturar** and **Registrar sin facturar** do;
- buyer/debtor versus fiscal receiver;
- A/B matrix and why users do not choose a letter freely;
- partial sale success message and “do not repeat sale/payment”;
- queue states/actions and when admin is required;
- old-sale date confirmation;
- homologation/simulation labels;
- reconciliation procedure without blind reissue;
- A-standard evidence prerequisite;
- rollback uses feature flag, never history rewrite or data deletion.

Update the existing ARCA guide with `/facturacion/configuracion` and `/facturacion/cola`.

- [ ] **Step 6: Commit the compatible implementation with the flag off**

```bash
git add src/integrations/supabase/types.ts docs/facturacion-receptor-fiscal-operacion.md \
  docs/facturacion-afip-paso-a-paso.md
git diff --check
git status --short
git commit -m "docs(fiscal): documentar operación y rollout seguro"
```

At this point the code is deployable with `facturacion_receptor_v2_enabled=false` and `facturacion_legacy_writer_enabled=true`, but this plan does not authorize deployment.

- [ ] **Step 7: Production gate — stop and request explicit deployment authority**

After approval, deploy schema + compatible readers/writers with the feature flag off. Verify:

```text
health and auth
queue read path
current legacy writes still succeed
no unexpected RLS/advisor errors
no ARCA write call
```

Wait for old Vercel instances to drain before any backfill/cutover. Do not push, migrate production or flip the flag without this separate authority.

- [ ] **Step 8: Dry-run and prepare the gated backfill only after the compatible deployment**

Run `backfill_cola_fiscal(false)` and compare classification counts to independent read-only SQL; abort on unexpected totals. Generate the `backfill_cola_fiscal` migration so it calls the applying mode and validates constraints, but do **not** apply it while the legacy flag is on. Do not infer missing history and do not emit.

- [ ] **Step 9: Cut over only after delta reconciliation**

Use one controlled fiscal-maintenance window in this exact order:

1. atomically set `facturacion_legacy_writer_enabled=false` while v2 remains false; `crear_venta` now rejects new positive legacy A/B/C rows before any commercial effect;
2. wait for in-flight legacy Vercel requests and database transactions to drain;
3. in the fenced window, apply the prepared backfill migration, reconcile its final counts and install the positive-sale guard—there is now no writer that can race with or write into the reclassified rows;
4. deploy code that removes the legacy one-click writer and switch the old budget RPC exact signature off;
5. keep legacy states readable until counts reach zero;
6. set `facturacion_receptor_v2_enabled=true` for admins only after the compatible deployment is healthy;
7. manually verify one mock/homologation story;
8. emit the first real invoice only with explicit human confirmation of sale, receiver, letter, date, total, emitter and PV;
9. monitor `RECONCILIAR/BLOQUEADO` before enabling selected employees.

The later `retirar_escritor_fiscal_legacy` migration must drop the exact old conversion signature and repeat exact revokes/grants. Removing legacy state values is a separate later migration only after zero-row proof.

- [ ] **Step 10: Final verification and handoff**

Record:

- migration filenames/checksums and local/prod status;
- feature-flag value;
- A-standard evidence status per emitter;
- sequence probes for types 1 and 6 (read-only);
- queue counts by state/validity;
- tests/build/deployment identifiers;
- any manual follow-up owned by accountant/admin.

Do not claim production-ready A/B emission merely because type 1 and 6 sequence probes respond; A standard requires the explicit administrative evidence from Task 6.
