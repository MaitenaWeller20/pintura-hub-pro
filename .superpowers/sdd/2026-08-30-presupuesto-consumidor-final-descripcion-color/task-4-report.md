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
