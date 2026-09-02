# Task 4 report — descripción editable por línea

## Implementación

- Venta directa: la grilla usa un `Input` accesible por línea, con `maxLength`
  tomado de `MAX_DESCRIPCION_ITEM`, ayuda visible y `readOnly` para las líneas
  heredadas de una factura. El adaptador único que crea la venta conserva
  `descripcion` junto con los datos comerciales.
- Presupuestos: alta y edición usan `descripcion` como estado de fila. Alta la
  inicia desde catálogo; edición desde `presupuesto_items.descripcion`. Cambiar
  cantidad o repreciar no sustituye el texto. Ambos writers incluyen
  `descripcion`; el detalle identifica y muestra la descripción congelada.
- Impresión: las regresiones comprueban el texto exacto `Base 10 L (Código
1234)` en PDF de presupuesto, snapshot/ticket fiscal, reimpresión que prefiere
  el snapshot y NC vinculada.

## TDD y verificación

- RED observado: `npx vitest run src/routes/_authenticated/ventas.nueva.test.ts`
  falló porque la ruta montada, después de agregar P-1, no exponía el input
  `Descripción de P-1`.
- GREEN: el mismo test valida edición, límite de 160, ayuda, payload de creación
  y `readonly` para NC heredada.
- `npx vitest run src/routes/_authenticated/ventas.nueva.test.ts src/lib/presupuesto-pdf.test.ts src/lib/fiscal/comprobante-pdf.test.ts src/lib/fiscal/impresion.test.ts`
  — 4 archivos, 98 tests verdes.
- `npm run typecheck`, `npm run build` y `git diff --check` verdes.
- React review: no se introdujeron efectos de estado derivado, cierres obsoletos,
  componentes inline ni mutaciones de listas; los campos tienen etiqueta y ayuda
  programáticamente asociada.

## Alcance adicional mínimo

- `src/lib/fiscal/snapshot-v3.test-fixture.ts` acepta una descripción opcional
  sólo para construir una NC con el texto exacto de aceptación. Es una utilidad
  de test mínima; no afecta runtime ni límites fiscales/autorización.

## Warnings históricos

- ESLint focal informa 49 `no-explicit-any` preexistentes en las cuatro rutas
  editadas; esta tarea no agregó ninguno.
- El build finalizó correctamente. Conserva warnings previos del plugin de rutas
  por tests dentro de `src/routes`, `inputValidator()` de TanStack Start y
  módulos Node externalizados por dependencias fiscales.

## Fix round 1/5 — review independiente

### Hallazgos corregidos

- **Crítico — preview/create divergían:** la preview fiscal reconstruía `items`
  desde la grilla y omitía `descripcion`; creación ya usaba `itemsPayload`. La
  preview ahora reutiliza exactamente ese único adaptador de filas normalizadas.
- **Importante — cobertura de presupuestos:** se agregaron montajes de alta,
  edición y detalle. Alta envía la descripción; edición carga el snapshot,
  conserva el texto tras cantidad/reprecio y lo manda al writer; detalle lo
  muestra. Los tests llevan prefijo `-` para que el generador de rutas no los
  trate como rutas productivas.
- **Importante — clave de fila:** venta directa permite repetir un producto, por
  lo que `key={i}` podía reciclar una fila editable al borrar una vecina. Cada
  fila recibe `lineaId` al agregar o heredar de factura y la tabla usa esa clave
  estable; el payload comercial no recibe ese identificador. La regresión repite
  P-1, personaliza la segunda línea y confirma que sobrevive al borrar la
  primera.

### RED → GREEN observado

1. `npx vitest run src/routes/_authenticated/ventas.nueva.test.ts`
   - **RED:** 11 tests, 1 fallo. La preview montada llamó a
     `previsualizarEmisionFiscal` sin `descripcion` mientras creación contenía
     `Base 10 L (Código 1234)`.
   - **GREEN:** 11 tests, 11 pasaron tras reutilizar `itemsPayload`.
2. `npx vitest run src/routes/_authenticated/-presupuestos.nuevo.test.ts 'src/routes/_authenticated/-presupuestos.editar.$id.test.ts'`
   - 2 archivos, 3 tests pasaron: los nuevos montajes cubren el contrato de
     alta, edición/reprecio y detalle ya persistido.
3. `npx vitest run src/routes/_authenticated/ventas.nueva.test.ts src/routes/_authenticated/-presupuestos.nuevo.test.ts 'src/routes/_authenticated/-presupuestos.editar.$id.test.ts' src/lib/presupuesto-pdf.test.ts src/lib/fiscal/comprobante-pdf.test.ts src/lib/fiscal/impresion.test.ts`
   - 6 archivos, 102 tests pasaron.
4. `npm run typecheck`, `git diff --check` y `npm run build` pasaron.

### Scope adicional de pruebas

- `src/routes/_authenticated/-presupuestos.nuevo.test.ts` y
  `src/routes/_authenticated/-presupuestos.editar.$id.test.ts` son nuevos
  harnesses jsdom de rutas reales; sólo reemplazan I/O, router y el borde del
  diálogo fiscal. No modifican runtime, ACL ni fiscalidad.

### Warnings del fix

- ESLint focal continúa con los mismos 49 `no-explicit-any` históricos en las
  rutas existentes; los dos harnesses nuevos no agregan findings.
- Build verde. Permanece el warning histórico por `ventas.nueva.test.ts` dentro
  de rutas, además de deprecaciones `inputValidator()` y módulos Node
  externalizados. Los nuevos tests con prefijo `-` no generan warnings de rutas.
