# Informe Tarea 10 — UI NC fiscal por período

## Commit

- `22fcc7b4fb8b556b30ac5663fd2c74771d0f23e1 feat(ui): agregar flujo de NC fiscal por período`

## Diseño aplicado

- En Nueva venta, la NC fiscal v2 presenta dos caminos explícitos: reversar una factura específica o asociar por período. El segundo sólo aparece cuando coinciden v2, flag de período y capacidad efectiva `puedeEmitirNcPeriodo`.
- El editor por período es un bloque compacto "Asociación fiscal por período". Mantiene fechas vacías, motivo, modalidades excluyentes (productos / concepto), resolución excluyente (reintegro exacto / saldo a favor), estimaciones de neto-IVA-total con T3 y efectos posteriores al CAE.
- La creación usa `crearNotaCreditoPeriodoFiscal`, una key UUID estable durante el intento y redirige a la cola fiscal con la venta pendiente. No reutiliza el writer de ventas comunes.
- La cola reconoce los campos v3 de período, abre el diálogo fiscal con contexto de período, permite receptor comercial/u otro receptor y envía la selección automática de letra al servidor. La letra no se ofrece como control editable. Antes de emitir exige marcar la confirmación del período.
- La lista/exportación comercial filtra `PENDIENTE_FISCAL`; la cola se mantiene gobernada por `afip_estado` y no agrega filtro comercial `ACTIVA`.

## Archivos

- Creados: `src/lib/nota-credito-periodo-ui.ts`, sus pruebas, `src/components/ventas/editor-nota-credito-periodo.tsx` y sus pruebas.
- Integrados: nueva venta, listado comercial, diálogo/resumen fiscal y cola fiscal.
- Ajustada la fachada de previsualización/emisión existente para transportar el selector interno `AUTOMATICA_NC_PERIODO` hasta el dominio ya autoritativo; no se implementó ARCA ni se modificó la regla de servidor.

## TDD

- RED: `nota-credito-periodo-ui.test.ts` falló por módulo inexistente; `editor-nota-credito-periodo.test.ts` falló por componente inexistente.
- GREEN: helpers, editor y controles de diálogo implementados; las pruebas focales posteriores pasaron (84 pruebas, 8 omitidas).

## Verificaciones

- Focal: `npx vitest run src/lib/nota-credito-periodo-ui.test.ts src/components/ventas/editor-nota-credito-periodo.test.ts src/components/fiscal/dialogo-emision-validacion.test.ts src/components/fiscal/dialogo-emision-fiscal.test.ts src/lib/fiscal/cola.test.ts` → 84 pasadas, 8 omitidas.
- Completa: `npx vitest run` → 75 archivos pasados, 2 omitidos; 1575 pruebas pasadas, 22 omitidas.
- Tipos: `npm run typecheck` pasó.
- Formato y diff: Prettier focal y `git diff --check` pasaron.
- Lint focal de archivos nuevos y componentes/fachadas modificadas pasó. El lint de `ventas.nueva.tsx` y `ventas.index.tsx` completos conserva errores `@typescript-eslint/no-explicit-any` preexistentes en esas rutas; no se agregaron `any` en las líneas nuevas.

## Accesibilidad y revisión React

- Labels asociados, mensajes `role=alert`, `aria-describedby` para fechas/motivo, radios y checkbox navegables por teclado, y estados `disabled` durante submit.
- Se mantuvieron imports directos y componentes fuera de la ruta. No se introdujeron effects para estado derivado ni fetches nuevos: el editor reutiliza el catálogo ya cargado y memoiza su proyección específica.
- No se realizó QA visual en navegador autenticado: el worktree no trae una sesión/datos de UI locales preconfigurados. La cobertura de componente corre en jsdom; queda recomendable una pasada manual responsiva con una cuenta autorizada y flag de staging.

## Riesgos / límites

- No se implementaron PDF, copy de outage ni detalle auditado de T11, ARCA real, deploy, push ni activación de flags.
- La DB y el dominio continúan siendo autoritativos para importes, permisos, letra y estado fiscal; la UI sólo calcula y explica estimaciones.

## Fix round 1

### Correcciones aplicadas

- El diálogo de NC por período ya no bloquea `Revisar datos fiscales` cuando la letra solicitada es `null`: ese valor representa la resolución automática. El recorrido montado llega a preview, confirmación de período y emisión.
- `ReceptorFiscalForm` modela explícitamente la letra automática: permite cliente comercial, favorito y otro receptor; el receptor manual exige CUIT y condición fiscal, ofrece las cuatro condiciones posibles y deja que el servidor resuelva A/B/C. La condición confirmada por ARCA se vuelve de sólo lectura y un fallo mantiene la preview bloqueada con error asociado y foco en el CUIT.
- El resumen post-preview de `Asociación fiscal por período` incorpora importe fiscal, receptor y letra resuelta como datos no editables.
- La cola combina flag y capacidad efectiva sólo para filas NC por período. Sin ambos, `Facturar` queda deshabilitado con su explicación; las ventas v2 ordinarias conservan `puedeFacturar`. La defensa también existe en el callback de acción.
- Al volver de `search.venta`, una fila facturable se selecciona y abre automáticamente una única vez por venta. El ciclo conserva navegación/reload y no reabre al cerrar. Tras un `APROBADO`, se activa el detalle comercial además del resultado de cola.
- El selector de IVA del ajuste deriva directamente de `ALICUOTAS_SOPORTADAS` (0, 2,5, 5, 10,5, 21 y 27). La consulta comercial aplica `.neq('estado', 'PENDIENTE_FISCAL')` antes de `order`/`limit`, conservando la defensa de UI/exportación.
- El editor conserva la misma idempotency key y una única creación durante doble click/reintento visual.

### TDD (RED → GREEN)

- RED: el diálogo por período dejaba deshabilitado el botón de revisión al recibir letra automática; la prueba montada reprodujo el bloqueo. GREEN: el bloqueo de letra nula quedó limitado a flujos no período.
- RED: `Otro receptor` no cambiaba de estado si no había letra A/B. GREEN: se habilitó el modo automático y las pruebas montadas validan CUIT/condición confirmados y error ARCA.
- RED: el cierre del diálogo podía reabrir tras mover la fila en la cola. GREEN: la marca de apertura es por venta y las pruebas cubren create→open, cierre sin replay y aprobado→detalle.

### Verificaciones Fix round 1

- Focal montada: `npx vitest run src/components/fiscal/dialogo-emision-fiscal.test.ts src/components/fiscal/cola-fiscal-tabla.test.ts src/components/ventas/editor-nota-credito-periodo.test.ts src/routes/_authenticated/facturacion.cola-lifecycle.test.ts src/lib/nota-credito-periodo-ui.test.ts` → 43 pasadas.
- Completa: `npm test` → 75 archivos pasados, 2 omitidos; 1584 pruebas pasadas, 22 omitidas.
- Tipos: `npx tsc --noEmit` pasó.
- Calidad: Prettier focal, ESLint focal y `git diff --check` pasaron.

### React y accesibilidad

- Se revisaron dependencias de hooks: la lista de filas está memoizada para que la apertura automática no reaccione a arrays vacíos nuevos; no se agregaron fetches ni mutaciones duplicadas.
- Los errores del receptor usan `aria-invalid`, `aria-describedby` y `role=alert`; la validación enfoca el primer control inválido. Botones/controles conservan foco visible y los estados bloqueados son nativos.
- No se ejecutó un navegador autenticado/responsive: faltan sesión y datos locales reproducibles. La cobertura jsdom valida controles y teclado/foco del flujo; queda una pasada manual responsiva recomendada en staging.

### Commit Fix round 1

- `49225c94efe42e261ac1880bc55f76a1a76e0acb fix(ui): completar flujo NC fiscal por período`
