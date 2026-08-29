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
