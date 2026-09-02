# Restaurar nota de crédito interna sin factura — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Volver a permitir una nota de crédito manual sin factura asociada bajo esquema fiscal v2, manteniéndola estrictamente interna y reservando la nota fiscal asociada para `anular_venta`.

**Architecture:** El formulario de alta distinguirá una NC interna manual de los comprobantes fiscales: no pedirá factura origen, mantendrá condición/productos/pagos editables, enviará asociación nula y no redirigirá a emisión ARCA. El RPC `crear_venta` permitirá exactamente esa combinación; seguirá rechazando NC v2 asociadas creadas en forma directa.

**Tech Stack:** PostgreSQL/Supabase RPC, React 19, TanStack Router, TypeScript, Vitest, Playwright y scripts REST.

**Spec:** `docs/superpowers/specs/2026-09-02-correccion-forma-pago-y-nc-interna-design.md`

## Global Constraints

- Una NC manual v2 debe guardar `afip_cbte_asoc_id IS NULL` y `afip_estado = 'NO_APLICA'`.
- No solicitar CAE, no encolar emisión y no llamar ARCA.
- La NC fiscal v2 asociada continúa naciendo exclusivamente desde `anular_venta`.
- Preservar el flujo legacy y el cerco vigente para nota de débito.
- No afectar la copia del medio corregido que realiza `anular_venta`.
- Preservar cambios ajenos del worktree principal y no reescribir historia publicada.

---

### Task 1: Modelo explícito del formulario

**Files:**

- Modify: `src/lib/ventas-ui.ts`
- Modify: `src/lib/ventas-ui.test.ts`

- [ ] Escribir pruebas para una función pura `modoNotaNueva`: NC manual v2 es interna, sin selector de factura, editable y sin emisión; factura/recibo conservan su flujo; asociación fiscal v2 no es un modo elegible desde alta manual.
- [ ] Ejecutar `npx vitest run src/lib/ventas-ui.test.ts` y confirmar la falla por contrato ausente.
- [ ] Implementar el discriminante mínimo que concentre estas decisiones y evite condicionales contradictorios en la ruta.
- [ ] Repetir la prueba hasta verde.
- [ ] Commit: `test: definir modo de nota de crédito interna`.

### Task 2: Corregir el cerco del escritor v2

**Files:**

- Modify: `scripts/test-notas-v2-scope.sh`
- Modify: `scripts/test-notas-v2-rest.sh`
- Modify: `scripts/test-nota-credito-sin-factura.sh`
- Create: `supabase/migrations/20260902130000_restaurar_nota_credito_interna_v2.sql`

- [ ] Cambiar primero los contratos para exigir que una NC v2 sin asociación se cree con estado interno, mientras una NC v2 con asociación directa continúe rechazada y `anular_venta` continúe creando la fiscal.
- [ ] Mantener en el contrato las verificaciones de detalle, stock, pago/condición y edición posterior de la NC interna.
- [ ] Ejecutar los tres scripts y observar el rojo causado por el cerco actual.
- [ ] Redefinir la versión completa y vigente de `crear_venta` en una migración nueva. Para `NOTA_CREDITO`: permitir asociación nula como interna independientemente del writer fiscal; si hay asociación y el esquema es v2, rechazar con mensaje que indique usar `anular_venta`; conservar validaciones legacy cuando corresponda. Para `NOTA_DEBITO`, conservar el cerco actual.
- [ ] Asegurar en la rama interna que `afip_cbte_asoc_id` quede nulo, `afip_estado` sea `NO_APLICA` y no se cree una cola de emisión.
- [ ] Aplicar la migración local y ejecutar `bash scripts/test-notas-v2-scope.sh`, `bash scripts/test-notas-v2-rest.sh` y `bash scripts/test-nota-credito-sin-factura.sh` hasta verde.
- [ ] Ejecutar contratos fiscales vecinos, incluyendo `bash scripts/test-anular-venta-v2.sh` si está presente.
- [ ] Commit: `fix: restaurar nota de crédito interna en v2`.

### Task 3: Restaurar el alta manual editable

**Files:**

- Modify: `src/routes/_authenticated/ventas.nueva.tsx`
- Modify: `e2e/nota-credito.spec.ts`
- Modify: `e2e/nota-credito-guardar.spec.ts`

- [ ] Agregar en E2E el recorrido v2: elegir Nota de crédito, confirmar que no aparece selector de factura, editar cliente/condición/productos/pagos, guardar y verificar comprobante interno sin acción de emitir.
- [ ] Agregar una aserción que descarte redirección a la cola fiscal y otra que compruebe asociación nula mediante la UI o fixture de base.
- [ ] Ejecutar los E2E focalizados y registrar el rojo de la UI actual bloqueada.
- [ ] Reemplazar las ramas dispersas basadas en `esNotaCreditoV2` por el modo puro. En NC interna: quitar selector/obligatoriedad de factura, no clonar una venta origen, habilitar condición/productos/pagos, enviar `p_afip_cbte_asoc_id: null` y usar navegación normal de venta guardada.
- [ ] Mostrar un aviso breve: “Nota de crédito interna: no se informa a ARCA y no genera CAE”.
- [ ] Mantener intacto el acceso a anulación fiscal desde la venta original.
- [ ] Ejecutar `npx vitest run src/lib/ventas-ui.test.ts`, los E2E de nota de crédito, `npm run typecheck` y ESLint de los archivos tocados.
- [ ] Commit: `fix: habilitar alta de nota de crédito interna`.

### Task 4: Verificación de no regresión fiscal

**Files:**

- Verify only: migraciones, scripts y UI tocados en las tareas anteriores.

- [ ] Probar matrices: NC interna contado, NC interna cuenta corriente, NC fiscal automática por anulación, intento directo de NC v2 asociada, nota de débito v2 y factura común.
- [ ] Verificar que ninguna NC interna tenga `afip_cbte_asoc_id`, cola fiscal, CAE ni estado pendiente de emisión.
- [ ] Ejecutar `npm run test`, `npm run typecheck`, `npm run lint` y `npm run build`.
- [ ] Ejecutar todos los scripts fiscales modificados y los contratos de anulación vecinos.
- [ ] Revisar `git diff --check`, `git status --short` y el diff completo contra la especificación.
- [ ] Commit: `test: verificar nota de crédito interna y fiscal`.

