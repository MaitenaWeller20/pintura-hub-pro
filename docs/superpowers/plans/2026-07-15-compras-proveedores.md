# Compras y Proveedores — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development o superpowers:executing-plans para implementar tarea por tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** Agregar el circuito de compras a proveedores (registrar compras que suman stock, llevar la deuda con cada proveedor y sus pagos, con impacto correcto en el arqueo de caja).

**Architecture:** Espejo parcial de ventas/clientes. Toda la lógica de plata y stock vive en RPC SECURITY DEFINER transaccionales (patrón `crear_venta`). Las tablas transaccionales quedan cerradas a escritura directa; sólo las RPC las tocan. Compras registra un comprobante EXTERNO del proveedor (no lo emite), lo que cambia numeración y anulación respecto de ventas.

**Tech Stack:** TanStack Start, React 19, Supabase/Postgres (PL/pgSQL), TanStack Query, componentes en `src/components/app/`.

## Global Constraints

- Migraciones nuevas con timestamp posterior a `20260714260000`; idempotentes (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP ... IF EXISTS`).
- RPC de plata/stock: `SECURITY DEFINER SET search_path = public`, validan `auth.uid()`, validan sucursal (`is_admin(uid) OR sucursal_id = current_sucursal_id()`), calculan totales/usuario/`caja_sesion_id` en el servidor (nunca del cliente), `FOR UPDATE` donde corresponde.
- Montos de pago siempre positivos; la dirección (entrada/salida) la aplica `caja_esperado`. Rechazar `CTA_CTE` como forma de pago real.
- Perímetro cerrado: `compras`, `compra_items`, `proveedor_cc_movimientos`, `proveedor_pagos` → sólo lectura para `authenticated`, escritura por RPC. `proveedores` → escritura directa + guard (como `clientes`).
- Verificación por e2e (curl a RPC contra la base local) — el proyecto no tiene tests unitarios de negocio salvo `src/lib/fiscal/*.test.ts`. Aplicar migraciones a local con `docker exec ... psql`, NO `db push` (que iría a producción).
- Regenerar `src/integrations/supabase/types.ts` tras cada migración con `supabase gen types typescript --db-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres"`.
- Cada bloque: typecheck + tests en verde antes de commit. Revisión con Codex del diff antes de commitear. Spec de referencia: `docs/superpowers/specs/2026-07-15-compras-proveedores-design.md`.

---

### Task 1: Migración de esquema (tablas, enums, índices, guards, RLS, grants)

**Files:**
- Create: `supabase/migrations/20260715100000_compras_proveedores_schema.sql`
- Modify: `src/integrations/supabase/types.ts` (regenerado)

**Interfaces:**
- Produces: tablas `proveedores`, `compras`, `compra_items`, `proveedor_cc_movimientos`, `proveedor_pagos`; enum `proveedor_cc_tipo`; valores `COMPRA`/`ANULACION_COMPRA` en `tipo_movimiento_stock`; trigger `guard_proveedores_credito`.

- [ ] **Step 1: Escribir la migración** con el DDL del spec §3. Puntos exactos:
  - `ALTER TYPE public.tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'COMPRA'; ... 'ANULACION_COMPRA';` (ADD VALUE no corre dentro de una transacción con otros DDL en algunas versiones — ponerlos al inicio, en su propio bloque, o usar el patrón `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object`).
  - `CREATE TYPE proveedor_cc_tipo AS ENUM ('DEBITO','CREDITO')` (con guardia de duplicado).
  - `proveedores` (espejo de `clientes`: razon_social, cuit_dni text, condicion_iva usando enum `tipo_cliente`, telefono, email, direccion, condicion_cta_cte, activo, timestamps). Índice único parcial `uq_proveedores_cuit_activo` sobre `regexp_replace(cuit_dni,'\D','','g')` where no vacío y activo.
  - `compras` (spec §3): con `UNIQUE` parcial `(proveedor_id, tipo_comprobante, numero_comprobante) WHERE estado='ACTIVA'`, CHECK del `tipo_comprobante`, CHECK `condicion IN ('CONTADO','CTA_CTE')`, CHECK `estado IN ('ACTIVA','ANULADA')`, `caja_sesion_id` FK a `caja_sesiones`.
  - `compra_items` (spec §3, con snapshot codigo/descripcion).
  - `proveedor_cc_movimientos` (spec §3): `monto > 0`, `estado` default CONFIRMADO, `compra_id`/`pago_id` UNIQUE, `tipo proveedor_cc_tipo`.
  - `proveedor_pagos` (spec §3): `monto > 0`, `forma_pago text` CHECK contra las formas válidas SIN `CTA_CTE`, `caja_sesion_id`.
  - Trigger `set_updated_at` en las tablas con `updated_at`.
  - `guard_proveedores_credito` (copiar patrón de `guard_clientes_credito` en `20260713120000`): un no-admin no puede setear `condicion_cta_cte`.
  - RLS: `ENABLE ROW LEVEL SECURITY` en las 5. Policies SELECT por sucursal donde aplique; `proveedores` y `proveedor_cc_movimientos` legibles por authenticated (global). `proveedores` escritura directa (GRANT SELECT/INSERT/UPDATE) + policies; el resto sólo `GRANT SELECT` a authenticated.
  - `GRANT ALL ... TO service_role`.

- [ ] **Step 2: Aplicar a local**

Run: `CID=$(docker ps --format "{{.Names}}" | grep supabase_db | head -1); docker exec -i "$CID" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20260715100000_compras_proveedores_schema.sql`
Expected: sin errores (sólo NOTICE de guardias de duplicado).

- [ ] **Step 3: Regenerar tipos** con el comando de Global Constraints. Verificar `grep -c "proveedores\|compra_items\|proveedor_pagos" src/integrations/supabase/types.ts` > 0.

- [ ] **Step 4: typecheck**. Run: `bun run typecheck`. Expected: exit 0.

- [ ] **Step 5: Revisión Codex del DDL** (mcp__codex__codex, read-only): pedir que verifique constraints, RLS y el ADD VALUE al enum. Aplicar hallazgos.

- [ ] **Step 6: Commit.** `git add supabase/migrations/20260715100000_* src/integrations/supabase/types.ts && git commit -m "feat(compras): esquema de compras y proveedores"`

---

### Task 2: RPC `crear_compra` + trigger de estampado a caja

**Files:**
- Create: `supabase/migrations/20260715110000_crear_compra.sql`
- Test: `scratchpad/e2e-compras.sh` (curl a la RPC)

**Interfaces:**
- Consumes: tablas de Task 1; `caja_esperado`, `caja_sesiones` del arqueo; `is_admin`, `current_sucursal_id`.
- Produces: `crear_compra(p_proveedor_id uuid, p_sucursal_id uuid, p_tipo_comprobante text, p_numero text, p_fecha_comprobante date, p_fecha_vencimiento date, p_items jsonb, p_pagos jsonb, p_percepciones numeric, p_condicion text, p_observaciones text) RETURNS TABLE(compra_id uuid)`; trigger `trg_compras_estampar_caja`.

- [ ] **Step 1: Escribir la RPC + trigger.** Lógica (spec §4):
  - Valida auth, sucursal, proveedor activo. Si `condicion='CTA_CTE'` exige `condicion_cta_cte` del proveedor.
  - Calcula totales desde `p_items` (costo × cantidad, IVA por ítem, redondeo 2 decimales una vez por ítem — igual que `crear_venta`).
  - Inserta `compras` (totales calculados, usuario = auth.uid()) + `compra_items` con snapshot.
  - Suma stock por ítem: `INSERT INTO stock_sucursal (producto_id, sucursal_id, cantidad) VALUES (...) ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = stock_sucursal.cantidad + EXCLUDED.cantidad RETURNING (cantidad - EXCLUDED.cantidad) AS ant, cantidad AS nue` → insertar kardex tipo `COMPRA`.
  - Si `CTA_CTE`: `INSERT proveedor_cc_movimientos (tipo=DEBITO, monto=total, compra_id, ...)`.
  - Si `CONTADO`: si no hay caja abierta de la sucursal → `RAISE EXCEPTION 'Abrí la caja antes de registrar una compra al contado'`. Insertar los pagos en `proveedor_pagos` (rechazar forma `CTA_CTE`).
  - Trigger `trg_compras_estampar_caja` BEFORE INSERT en `compras` reutilizando `estampar_caja_sesion()` (ya genérica: usa NEW.sucursal_id).
  - Trigger BEFORE INSERT en `proveedor_pagos` reutilizando `estampar_caja_sesion()`.
  - REVOKE/GRANT EXECUTE a authenticated + service_role.

- [ ] **Step 2: Aplicar a local** (docker exec psql, como Task 1 Step 2).

- [ ] **Step 3: e2e** en `scratchpad/e2e-compras.sh` (login QA, obtener proveedor/producto/sucursal, abrir caja):
  - Crear proveedor con service_role (o via RPC futura); crear compra CONTADO 10 unidades → verificar stock subió 10, kardex COMPRA, `proveedor_pagos` creado, atado a caja.
  - Crear compra CTA_CTE → verificar DEBITO en el libro, saldo del proveedor = total.
  - Compra contado SIN caja abierta → debe fallar.
  - Doble carga misma factura (mismo proveedor/tipo/numero) → 23505.
  Run: `bash scratchpad/e2e-compras.sh`. Expected: todos los asserts OK.

- [ ] **Step 4: Revisión Codex** de la RPC. Aplicar hallazgos.

- [ ] **Step 5: Commit.** `git commit -m "feat(compras): RPC crear_compra + estampado a caja"`

---

### Task 3: RPCs de pago y anulación (`registrar_pago_proveedor`, `anular_compra`, `anular_pago_proveedor`, `proveedor_saldo`)

**Files:**
- Create: `supabase/migrations/20260715120000_pagos_anulaciones_proveedor.sql`
- Test: extender `scratchpad/e2e-compras.sh`

**Interfaces:**
- Consumes: Task 1 y 2.
- Produces: `registrar_pago_proveedor(p_proveedor_id, p_sucursal_id, p_monto, p_forma_pago, p_detalle) RETURNS uuid`; `anular_compra(p_compra_id) RETURNS void`; `anular_pago_proveedor(p_pago_id) RETURNS void`; `proveedor_saldo(p_proveedor_id) RETURNS numeric`.

- [ ] **Step 1: Escribir las RPCs.**
  - `proveedor_saldo`: `SELECT COALESCE(SUM(CASE tipo WHEN 'DEBITO' THEN monto ELSE -monto END),0) FROM proveedor_cc_movimientos WHERE proveedor_id=... AND estado='CONFIRMADO'`. STABLE SECURITY DEFINER.
  - `registrar_pago_proveedor`: exige caja abierta (RAISE si no); inserta `proveedor_pagos` (monto>0, valida forma ≠ CTA_CTE) + `proveedor_cc_movimientos` (tipo=CREDITO, pago_id).
  - `anular_compra`: `FOR UPDATE` la compra; si ya ANULADA raise; marca ANULADA; revierte stock por ítem con `UPDATE stock_sucursal SET cantidad = cantidad - <comprada> WHERE ... AND cantidad >= <comprada>` + `IF NOT FOUND` (salvo `permitir_stock_negativo` de settings) → RAISE 'No se puede anular: ya se vendió parte de esa mercadería'; kardex `ANULACION_COMPRA`; si CTA_CTE marca el DEBITO ANULADO; si CONTADO inserta pagos inversos (negados) atados a la caja abierta hoy.
  - `anular_pago_proveedor`: `FOR UPDATE`; marca el CREDITO ANULADO; inserta pago inverso en caja abierta.
  - REVOKE/GRANT.

- [ ] **Step 2: Aplicar a local.**

- [ ] **Step 3: e2e** (extender el script): pagar proveedor (saldo baja, sale de caja), anular pago (saldo vuelve), anular compra que subió stock (revierte), anular compra cuya mercadería ya se vendió (debe fallar por stock insuficiente), pago sin caja abierta (falla).
  Run: `bash scratchpad/e2e-compras.sh`. Expected: OK.

- [ ] **Step 4: Revisión Codex.** Aplicar hallazgos.

- [ ] **Step 5: Commit.** `git commit -m "feat(compras): pagos a proveedor y anulaciones"`

---

### Task 4: `caja_esperado` v3 (entradas/salidas/neto) + arqueo UI

**Files:**
- Create: `supabase/migrations/20260715130000_caja_esperado_entradas_salidas.sql`
- Modify: `src/routes/_authenticated/arqueo.tsx`

**Interfaces:**
- Consumes: `proveedor_pagos`, `compras` de Tasks 1-3.
- Produces: `caja_esperado(_sesion_id uuid) RETURNS jsonb` con forma `{ forma: { entra, sale, neto } }` (cambia el shape actual `{forma: monto}`).

- [ ] **Step 1: Reescribir `caja_esperado`.** Entradas = venta_pagos (ventas de la sesión) + cobranzas + movimientos INICIAL/INGRESO. Salidas = proveedor_pagos (de la sesión) + movimientos GASTO/RETIRO. Por forma de pago, devolver `entra`, `sale`, `neto = entra - sale`. Mantener STABLE SECURITY DEFINER + grants.

- [ ] **Step 2: Aplicar a local + regenerar tipos.**

- [ ] **Step 3: Adaptar `arqueo.tsx`.** El StatCard por forma y el cierre pasan a leer `neto` (con desglose Entradas/Salidas en el detalle). El `NumberInput` del cierre permite comparar contado contra `neto` (que puede ser negativo). Actualizar `totalEsperado` = suma de netos.

- [ ] **Step 4: typecheck + verificación visual** en el navegador: abrir caja, registrar una compra contado + un pago a proveedor, ver que el arqueo muestra la salida y el neto correcto; cerrar y ver la diferencia.

- [ ] **Step 5: Revisión Codex** del cambio de `caja_esperado` (que no rompa el arqueo existente de ventas). Aplicar hallazgos.

- [ ] **Step 6: Commit.** `git commit -m "feat(caja): arqueo con entradas/salidas/neto por forma de pago"`

---

### Task 5: Frontend — Proveedores (`/proveedores`)

**Files:**
- Create: `src/routes/_authenticated/proveedores.tsx`
- Modify: `src/routes/_authenticated/route.tsx` (sidebar), `src/routeTree.gen.ts` (autogenerado)

**Interfaces:**
- Consumes: tabla `proveedores`, `validarCuitDni` de `src/lib/fiscal/codigos.ts`.

- [ ] **Step 1: Crear la pantalla** espejo de `clientes.tsx`: PageHeader, buscador, DataTable, diálogo con validación de CUIT (reusar el patrón con `key`, `cuitError`, normalización, mapeo de error 23505). Campos: razon_social, cuit_dni, condicion_iva (tipo), telefono, email, direccion, condicion_cta_cte.

- [ ] **Step 2: Agregar al sidebar** en `route.tsx` un grupo "Compras" con Proveedores (y Compras, Task 6). Regenerar routeTree (dev server) o `bun run build`.

- [ ] **Step 3: typecheck + verificación visual**: alta, edición (no pisa con vacíos), CUIT inválido rechazado, CUIT duplicado rechazado.

- [ ] **Step 4: Commit.** `git commit -m "feat(compras): pantalla de proveedores"`

---

### Task 6: Frontend — Compras (`/compras` + `/compras/nueva`)

**Files:**
- Create: `src/routes/_authenticated/compras.index.tsx`, `src/routes/_authenticated/compras.nueva.tsx`
- Modify: `src/routes/_authenticated/route.tsx` (item Compras en el grupo)

**Interfaces:**
- Consumes: `crear_compra`, `anular_compra`, tablas `compras`/`compra_items`/`proveedores`/`productos`.

- [ ] **Step 1: `compras.index.tsx`** — listado (DataTable) con proveedor, número, fecha, total, estado (StatusPill), condición; acción anular (admin) llamando `supabase.rpc("anular_compra", ...)`; botón "Nueva compra".

- [ ] **Step 2: `compras.nueva.tsx`** — formulario espejo de `ventas.nueva.tsx`: seleccionar proveedor (buscador), tipo/número/fecha del comprobante + vencimiento, agregar ítems (buscar producto, cantidad, costo unitario, IVA), condición CONTADO/CTA_CTE, formas de pago (si contado). Al guardar, `supabase.rpc("crear_compra", ...)`. Totales calculados en vivo en el cliente (el server recalcula y es la fuente de verdad).

- [ ] **Step 3: typecheck + verificación visual**: crear una compra contado (con caja abierta) y una a cuenta; ver que aparecen en el listado y que el stock subió (en /stock).

- [ ] **Step 4: Revisión Codex** de las dos pantallas. Aplicar hallazgos.

- [ ] **Step 5: Commit.** `git commit -m "feat(compras): listado y alta de compras"`

---

### Task 7: Frontend — Cuenta corriente de proveedor (pestaña) + cierre

**Files:**
- Modify: `src/routes/_authenticated/cuentas-corrientes.tsx`

**Interfaces:**
- Consumes: `proveedor_saldo`, `registrar_pago_proveedor`, `anular_pago_proveedor`, `proveedor_cc_movimientos`.

- [ ] **Step 1: Agregar Tabs** (Clientes | Proveedores) a `cuentas-corrientes.tsx`. La pestaña Proveedores: lista de proveedores con cta cte + saldo (`proveedor_saldo`), detalle con el libro de movimientos y "Registrar pago" (`registrar_pago_proveedor`), anular pago. Reusar los componentes/estilos de la pestaña de clientes.

- [ ] **Step 2: typecheck + verificación visual**: ver el saldo de un proveedor con compras a cuenta, registrar un pago (baja el saldo y sale de la caja), verlo reflejado en el arqueo.

- [ ] **Step 3: Commit.** `git commit -m "feat(compras): cuenta corriente de proveedor"`

---

### Task 8: Verificación integral, Codex final y producción

- [ ] **Step 1: Suite e2e completa** (`scratchpad/e2e-compras.sh`): el circuito entero — proveedor → compra contado → compra a cuenta → pago → anular pago → anular compra → arqueo con salidas. Todos OK.
- [ ] **Step 2: typecheck + `bun run test`** en verde.
- [ ] **Step 3: Revisión Codex del diff completo** de la feature (2 pasadas si hay hallazgos). Aplicar.
- [ ] **Step 4: Verificación visual** de las 3 pantallas + arqueo.
- [ ] **Step 5: Commit final + push.**
- [ ] **Step 6: Producción** (con autorización del usuario): `dry-run` de las migraciones, verificar duplicados de CUIT de proveedor en prod, `db push`, deploy a Vercel, verificar el sitio.

---

## Self-review (cobertura del spec)

- Spec §3 (modelo) → Task 1. §4 (RPCs) → Tasks 2-3. §5 (arqueo) → Task 4. §6 (seguridad) → Task 1 (RLS/grants/guards) + RPCs. §7 (frontend) → Tasks 5-7. §8 (verificación) → cada task + Task 8. §9 (orden) → orden de las tasks. Sin gaps.
- Tipos consistentes: `crear_compra` devuelve `compra_id`; `proveedor_saldo` numeric; `caja_esperado` cambia a `{forma:{entra,sale,neto}}` y Task 4 Step 3 adapta el consumidor (arqueo.tsx). Sin placeholders.
