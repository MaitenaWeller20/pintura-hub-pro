# Corrección de forma de pago de una venta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que un administrador cambie únicamente la forma de pago de un pago positivo perteneciente a una venta activa, con auditoría inmutable y recálculo atómico de cualquier cierre de caja afectado.

**Architecture:** Un RPC `security definer` será el único escritor. Bloqueará pago y venta, validará versión optimista, actualizará solo `forma_pago`/`detalle`/versión y registrará una auditoría append-only. Si la caja efectiva ya está cerrada, recalculará el cierre dentro de la misma transacción. La UI administrativa vivirá en el detalle de venta y consumirá ese RPC.

**Tech Stack:** PostgreSQL/Supabase RLS y RPC, React 19, TanStack Router, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-correccion-forma-pago-y-nc-interna-design.md`

## Global Constraints

- No habilitar edición de monto, alta o baja de pagos.
- Rechazar ventas anuladas, pagos no positivos, `CTA_CTE`, ausencia de cambio y conflictos de versión.
- Resolver caja efectiva como `COALESCE(venta_pagos.caja_sesion_id, ventas.caja_sesion_id)`.
- En un cierre afectado, preservar efectivo contado, `efectivo_dejado`, observaciones y fondos futuros; para medios no efectivos, hacer contado igual a esperado y diferencia cero.
- Mantener toda la operación y ambas auditorías en una transacción.
- Preservar cambios ajenos del worktree principal y no reescribir historia publicada.

---

### Task 1: Contrato puro de corrección

**Files:**

- Create: `src/lib/correccion-forma-pago.ts`
- Create: `src/lib/correccion-forma-pago.test.ts`

- [ ] Escribir pruebas que exijan: lista de medios permitidos sin `CTA_CTE`; validación de cambio real y motivo de 5–1000 caracteres; sanitización de errores del RPC; lectura segura de una auditoría de caja marcada `forma_pago_venta`.
- [ ] Ejecutar `npx vitest run src/lib/correccion-forma-pago.test.ts` y confirmar el rojo por módulo inexistente.
- [ ] Implementar tipos y funciones puras mínimas, sin acceso a Supabase ni React.
- [ ] Repetir la prueba hasta verde.
- [ ] Commit: `test: definir contrato de corrección de pagos`.

### Task 2: Persistencia, permisos y transacción

**Files:**

- Create: `scripts/test-corregir-forma-pago-venta.sh`
- Create: `supabase/migrations/20260902120000_corregir_forma_pago_venta.sql`

- [ ] Crear un test SQL/REST que demuestre inicialmente que no existen `venta_pagos.correccion_version`, `venta_pago_correcciones` ni `corregir_forma_pago_venta`.
- [ ] Cubrir en el test: rechazo no-admin; venta anulada; pago cero/negativo; método `CTA_CTE`; mismo método; motivo inválido; versión obsoleta; actualización feliz sin caja cerrada; auditoría inmutable; concurrencia/versionado; caja cerrada con pago directo y con caja heredada desde venta; rollback total ante error de recálculo.
- [ ] Ejecutar el script contra la base local de pruebas y conservar la falla esperada.
- [ ] Agregar `correccion_version integer NOT NULL DEFAULT 0 CHECK (correccion_version >= 0)` a `venta_pagos`.
- [ ] Crear `venta_pago_correcciones` con pago, venta, caja efectiva nullable, administrador, fecha, motivo, versiones anterior/nueva, monto, forma/detalle anterior y nueva. Habilitar RLS de lectura solo para admin y bloquear `UPDATE`/`DELETE` mediante trigger.
- [ ] Implementar `public.corregir_forma_pago_venta(p_venta_pago_id uuid, p_forma_pago_nueva forma_pago, p_motivo text, p_version_esperada integer)` como `security definer`, con `search_path` fijo, validación de `auth.uid()`/admin y bloqueos de fila.
- [ ] Después de cambiar el pago, si la caja efectiva está cerrada, adquirir el bloqueo/advisory usado por caja, llamar `caja_esperado`, reconstruir `esperado`, `contado`, `diferencia` y totales según la especificación, incrementar la versión del cierre e insertar `caja_cierre_correcciones` con `campos_modificados = ARRAY['forma_pago_venta']` y metadatos del pago en los snapshots JSON.
- [ ] Revocar ejecución pública, concederla únicamente a `authenticated`/`service_role`, y asegurar que el cliente no pueda escribir directamente tablas de auditoría.
- [ ] Aplicar migraciones en la base local y ejecutar `bash scripts/test-corregir-forma-pago-venta.sh` hasta verde.
- [ ] Ejecutar los contratos de caja existentes relevantes: `bash scripts/test-correccion-cierre.sh`, `bash scripts/test-caja-r11.sh` y `bash scripts/test-caja-sesion-en-pagos.sh` si están presentes.
- [ ] Commit: `feat: auditar corrección de forma de pago`.

### Task 3: Tipos y UI administrativa

**Files:**

- Modify: `src/integrations/supabase/types.ts`
- Create: `src/components/ventas/dialogo-corregir-forma-pago.tsx`
- Create: `src/components/ventas/historial-correcciones-pago.tsx`
- Modify: `src/components/ventas/dialogo-detalle-venta.tsx`
- Modify: `src/routes/_authenticated/ventas.index.tsx`

- [ ] Actualizar tipos generados equivalentes para la nueva columna, tabla y RPC, manteniendo firmas exactas.
- [ ] Añadir al diálogo de detalle una acción por cada pago positivo cuando `puedeCorregirPagos` sea verdadero; mostrar monto solo lectura, forma actual, selector permitido y motivo obligatorio.
- [ ] Llamar al RPC con la versión observada, mostrar el error sanitizado, impedir doble envío y refrescar pago, venta e historial tras éxito.
- [ ] Mostrar historial de correcciones con fecha, administrador, medio anterior/nuevo y motivo. No renderizar controles de monto, alta o eliminación.
- [ ] Pasar `puedeCorregirPagos={Boolean(cu?.isAdmin)}` desde el índice de ventas.
- [ ] Ejecutar `npm run typecheck`, `npx vitest run src/lib/correccion-forma-pago.test.ts` y ESLint sobre los archivos tocados.
- [ ] Commit: `feat: corregir forma de pago desde ventas`.

### Task 4: Historial de caja y recorrido integral

**Files:**

- Modify: `src/components/caja/correccion-cierre.tsx`
- Create: `e2e/corregir-forma-pago-venta.spec.ts`

- [ ] Hacer que el historial de caja identifique `forma_pago_venta`, muestre la venta/pago y explique el recálculo automático sin presentar la corrección como un cambio manual del efectivo contado.
- [ ] Escribir E2E admin: abrir venta, corregir un pago, verificar monto bloqueado, ausencia de alta/baja, persistencia del nuevo medio e historial.
- [ ] Escribir E2E no-admin: confirmar que la acción no existe.
- [ ] Incluir caso de caja cerrada y comprobar que esperado/diferencia almacenados cambian, mientras efectivo contado y `efectivo_dejado` permanecen.
- [ ] Ejecutar `npx playwright test e2e/corregir-forma-pago-venta.spec.ts` con el entorno local del proyecto.
- [ ] Ejecutar `npm run test`, `npm run typecheck`, `npm run lint` y `npm run build`.
- [ ] Revisar `git diff --check`, `git status --short` y el diff completo contra esta especificación.
- [ ] Commit: `test: cubrir corrección integral de forma de pago`.

