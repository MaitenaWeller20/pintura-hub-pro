# Task 5 report — diálogo, E2E y gate de entrega

Fecha: 2026-08-30
Workspace: `/private/tmp/quimex-presupuesto-color.N9cBhs`
Base: `b9f1300`
Commit requerido: `test(presupuestos): verificar consumidor final y colores`

## Resultado

Task 5 implementada y verificada. El presupuesto anónimo abre en modo Consumidor Final, fuerza contado, envía `cliente_id: null` y usa el `clienteId` efectivo de la RPC para la facturación posterior. Sucursal y caja se informan antes de convertir; cualquier preflight incompleto, error, mantenimiento o ausencia de caja bloquea las acciones. La mutación congela cierre y controles, y un retry ambiguo conserva exactamente key y payload.

La historia E2E real convierte en General Paz, factura en mock, valida DB/stock/pago/caja/receptor/descripción, revisa detalle y PDF, y confirma ausencia de duplicación. También cubre la rama sin caja y la regresión identificada/CTA_CTE. La fixture restaura configuración y secuencias compartidas.

## Archivos

- `src/components/presupuestos/dialogo-convertir-presupuesto.tsx`
  - RadioGroup `CONSUMIDOR_FINAL` / `IDENTIFICADO`.
  - preflight autenticado único por apertura;
  - sucursal, caja y hora visible;
  - anónimo sin picker/CTA_CTE, contado y null explícito;
  - freeze completo, error humano seguro y guards de ciclo/unmount;
  - key y payload estables con bloqueo síncrono del doble clic;
  - callback con receptor efectivo del servidor.
- `src/components/presupuestos/dialogo-convertir-presupuesto.test.tsx`
  - 11 pruebas montadas, incluida regresión StrictMode y resultado tardío.
- `src/routes/_authenticated/presupuestos.$id.tsx`
  - conserva directamente el objeto `PresupuestoConvertido` autoritativo para abrir fiscal, antes e independientemente de los refetch.
- `e2e/presupuestos-facturacion.spec.ts`
  - seis historias seriales, autocontenidas respecto de otros specs.
- `e2e/fixtures/fiscal.ts`
  - tres presupuestos, producto/color y caja determinística;
  - preparación mock separada de O'Higgins y General Paz;
  - lectura de hechos comerciales y cierre normal de caja;
  - cleanup auditado y restauración exacta de secuencias VENTA.
- `docs/presupuestos-consumidor-final-operacion.md`
  - consultas de candidato, cajas, flags/retiro legacy, conversión, descripción y efectos;
  - rollout y rollback fail-closed.
- `vitest.config.ts`
  - utilidad mínima de harness: incluye `.test.tsx` además de `.test.ts`, necesaria para ejecutar el archivo exigido por el brief.
- `.superpowers/sdd/2026-08-30-presupuesto-consumidor-final-descripcion-color/progress.md`
  - ledger actualizado con RED/GREEN, fallos reales y gates.

## TDD y fallos observados

1. RED montado inicial: 9/9 fallaron por ausencia del selector/preflight/semántica anónima.
2. GREEN inicial: 9/9 pasaron con la implementación mínima.
3. RED StrictMode: el callback quedó en cero porque el cleanup de ensayo dejaba `mountedRef=false`.
4. GREEN StrictMode: el setup rearma `mountedRef`; suite ampliada luego a 11/11 con unmount tardío.
5. RED E2E inicial: las historias de lectura/foco pasaron; la conversión no abría fiscal por el mismo guard StrictMode.
6. Segundo fallo E2E: fiscal ya abría con Consumidor Final, pero el preview fallaba porque sólo se preparaba la configuración de O'Higgins. Se agregó configuración/restauración local de General Paz.
7. Tercer fallo E2E: el PDF sí contenía la descripción, serializada como literal PDF con paréntesis escapados. La aserción se hizo exacta sobre esa representación.
8. Cuarto fallo E2E: la RPC CTA_CTE respondió que el cliente de fixture no tenía cuenta corriente. El trace probó que el clic y POST sí ocurrieron; se corrigió sólo el dato de fixture.
9. GREEN final: E2E completo 6/6.

No se aumentaron timeouts para ocultar ninguno de estos fallos.

## Contratos y seguridad

- V2 siempre incluye `cliente_id`; en anónimo es `null`.
- El presupuesto sigue con cliente null; la venta usa el único genérico global efectivo.
- El diálogo no confía en el preflight para la transacción: la RPC sigue siendo autoritativa sobre receptor y caja.
- Loading, fetch, error o caja null deshabilitan ambas acciones.
- Sólo errores redactados se exponen con `role="alert"`; no se muestran detalles SQL, tokens ni constraints.
- Un ref síncrono bloquea el segundo evento antes del render pendiente.
- La entrada completa se congela en el primer intento y se reutiliza byte-lógicamente en retry ambiguo.
- El ciclo de apertura y el guard de montaje descartan resultados después de cierre externo/unmount.
- Legacy permanece retirado; no se cambian capacidades fiscales ni ACL.

## Fixture y cleanup

El fixture se niega a operar fuera de `127.0.0.1`/`localhost` y valida el puerto PostgreSQL contra `supabase/config.toml`. Las credenciales efímeras usan UUID propios y ambos campos marcador `T13_TEST_ONLY_NO_NETWORK`; nunca se llama ARCA real.

Para cada emisor se guarda y restaura la fila completa relevante, punto de venta y credencial productiva previa. Si la credencial no existía, el cleanup sólo borra la fila cuyo ID, emisor, ambiente y ambos marcadores coinciden. Luego compara el estado restaurado.

Las secuencias `VENTA` de las dos sucursales se toman antes de la fixture y se restauran después de retirar todas sus ventas. Con la ventana local exclusiva, la auditoría final mostró:

- 0 presupuestos determinísticos;
- 0 perfiles de fixture;
- 0 cajas abiertas;
- 0 credenciales mock;
- `comprobante_secuencias` VENTA vacío, igual al baseline post-reset;
- flags restaurados a V2 `false`, legacy `false`;
- emisores y puntos de venta restaurados al baseline.

## Diseño y React

Se conservó CasaForma: mismos Dialog, Button, Select, colores, radios y resumen; se añadió sólo la jerarquía necesaria para que mostrador vea receptor, sucursal y caja. No hubo rediseño ni patrón visual nuevo.

La revisión React dejó una fuente autoritativa para la conversión, evitó depender de refetch para abrir fiscal, mantuvo un único query de preflight y protegió callbacks asíncronos. Los archivos nuevos/reescritos pasan ESLint. La ruta conserva exactamente cuatro `no-explicit-any` históricos: las mismas expresiones ya fallaban en `HEAD`, sólo cambiaron de línea por el diff.

## Matriz final limpia

Ejecutada después de `supabase db reset --local`:

| Gate | Resultado |
| --- | --- |
| `bash scripts/test-descripcion-personalizada-items.sh` | PASS |
| `bash scripts/test-presupuesto-consumidor-final-caja.sh` | PASS, concurrencia y secuencias incluidas |
| `bash scripts/test-editar-presupuesto.sh` | PASS, 19/19 |
| `bash scripts/test-venta-fiscal-atomica.sh` | PASS |
| `npm test` | PASS, 85 archivos y 1778 tests; 2 archivos/22 tests omitidos |
| `npm run typecheck` | PASS |
| `INVOICING_MOCK_MODE=true npm run build:vercel` | PASS |
| `npm run e2e -- e2e/presupuestos-facturacion.spec.ts` | PASS, 6/6 |
| `git diff --check` | PASS |

El build conserva warnings históricos de rutas-test sin prefijo, `inputValidator()` deprecado y módulos Node externalizados. El E2E conserva el `Failed to fetch` esperado del primer `getUser` previo al login del helper existente. No se introdujeron warnings nuevos de Task 5.

## Runbook

El runbook dice expresamente:

- la conversión no autoabre caja;
- legacy sigue retirado y no se reactiva para rollback;
- esta función comercial no necesita otro certificado ARCA;
- el rollback apaga V2 y deja legacy apagado, sin borrar ventas ni evidencia.

Las consultas de preflight del runbook se ejecutaron contra el Supabase local y su sintaxis pasó.

## Restricciones respetadas

No se usó proyecto remoto, `--linked`, `db push`, Vercel deploy, push, rebase, amend, force push, certificados reales ni ARCA real. No se modificó historia publicada.

## Gate posterior al commit original

`npm run lint:no-new-debt` pasó con árbol limpio: 983 hallazgos históricos
actuales contra 4273 en la base. No quedó deuda nueva de Task 5.

## Review round 1 — retry ambiguo

La primera revisión independiente marcó un hallazgo Important: después de un
fallo ambiguo, la UI volvía a habilitar edición. Cambiar receptor, cliente o
condición podía reconstruir otro payload con la clave original; cambiar pagos
dejaba una UI distinta del request congelado.

Se agregó un ciclo TDD montado específico. El RED fue 2/12: el radio seguía
habilitado y, al intentar editar cliente y pagos, el editor pasó de uno a dos
pagos. El GREEN quedó 12/12 con un estado explícito de intento ambiguo que:

- congela receptor, picker, condición, pagos, Cancelar, X y Escape;
- conserva juntos payload, `idempotency_key` y la acción original de facturar;
- habilita sólo esa misma acción para el replay;
- rechaza cambios también en los callbacks, además del bloqueo semántico del
  `fieldset`;
- prueba igualdad byte a byte mediante la serialización exacta de ambos
  requests y la igualdad explícita de la clave.

No se modificaron RPC, Supabase, fixtures, E2E, capacidades fiscales ni ARCA.

Verificación fresca del fix:

| Gate | Resultado |
| --- | --- |
| `npx vitest run src/components/presupuestos/dialogo-convertir-presupuesto.test.tsx` | PASS, 12/12 |
| `npm test` | PASS, 85 archivos/1779 tests; 2 archivos/22 tests omitidos |
| `npm run typecheck` | PASS |
| `INVOICING_MOCK_MODE=true npm run build:vercel` | PASS, sólo warnings históricos |

## Scoped re-review round 2 — transición determinística

La segunda revisión encontró dos estados incompletos. Un fallo no ambiguo no
descartaba el request estable ni rotaba la clave; cuando ocurría después de un
replay ambiguo, tampoco desbloqueaba el diálogo. Además, el botón permitía el
replay ambiguo aunque cambiara el preflight, pero `iniciarConversion` volvía a
bloquearlo con `puedeConvertir`.

El RED montado quedó en 4/16 fallos funcionales:

- V2 conservó la misma clave tras editar pagos y elegir facturar;
- legacy conservó la misma clave/payload tras elegir Factura A y Transferencia;
- un determinístico posterior a ambiguo dejó radio/cierre congelados;
- perder caja en el preflight dejó el botón habilitado pero la RPC en una sola
  llamada.

El GREEN 16/16 implementa una transición cerrada:

- sólo el último resultado ambiguo conserva `entradaEstableRef`,
  `facturarAhoraEstableRef` e `idempotencyKeyRef`;
- cada ambiguo repetido mantiene exactamente bytes, clave y acción, con todos
  los campos y el cierre congelados;
- cualquier fallo determinístico limpia ambos refs, rota inmediatamente a un
  UUID nuevo, apaga `intentoAmbiguo`, conserva el error humano y habilita la
  corrección;
- el intento siguiente serializa los pagos/acción V2 o comprobante/forma legacy
  visibles, sin reutilizar clave;
- el handler y los botones comparten la regla de replay: la misma acción puede
  recuperar una operación ambigua aunque el preflight ya muestre caja ausente.

El shim `scrollIntoView` agregado vive sólo en la prueba montada y cubre la
carencia de jsdom necesaria para operar los Select reales de Radix. No hubo
cambios de Supabase, RPC, E2E, fiscalidad ni red.

Verificación fresca del fix round 2:

| Gate | Resultado |
| --- | --- |
| `npx vitest run src/components/presupuestos/dialogo-convertir-presupuesto.test.tsx` | PASS, 16/16 |
| `npm test` | PASS, 85 archivos/1783 tests; 2 archivos/22 tests omitidos |
| `npm run typecheck` | PASS |
| `INVOICING_MOCK_MODE=true npm run build:vercel` | PASS, sólo warnings históricos |
| Prettier/ESLint focal y `git diff --check` | PASS |

El primer typecheck señaló únicamente que una prueba accedía a `.mock` desde el
tipo público del callback. La aserción se cambió al objeto completo entregado a
`onConvertida`; focal, suite completa y typecheck se ejecutaron otra vez y
quedaron verdes.
