# Plan de pruebas

## Por qué existe esto

Hasta ahora cada entrega se probaba a mano una vez y no quedaba nada corriendo
después. Una pantalla que se rompía en un rincón que nadie tocó no la agarraba
nadie hasta que la encontraba la clienta —y así aparecieron el diálogo de remitos
que no dejaba guardar, los productos que faltaban en el presupuesto y los PDF sin
el nombre de la empresa—.

La idea es que cada cosa que se rompió una vez tenga una prueba que lo detecte si
vuelve a pasar.

## Las tres capas

| Capa | Qué cubre | Cómo se corre | Cuánto tarda |
|---|---|---|---|
| Unitarias (vitest) | Cálculos: IVA, totales, CUIT, importaciones, filtros | `bun run test` | ~1 s |
| End-to-end (Playwright) | Que las pantallas abran, los diálogos se puedan usar y los ABMC funcionen | `bun run e2e` | ~2,5 min |
| Verificación en la base | Que las migraciones hagan lo que dicen | SQL a mano contra local antes de ir a producción | — |

```bash
bun run test        # unitarias
bun run typecheck   # tipos
bun run e2e         # end-to-end (levanta el dev server solo)
bun run e2e:ui      # end-to-end mirando qué hace el navegador
```

## Qué cubren las pruebas end-to-end

Están en `e2e/` y corren **siempre contra el entorno local**, nunca contra
producción: varias escriben datos.

### `humo.spec.ts` — las 24 pantallas
Cada pantalla detrás del login: abre, muestra contenido, no tira errores de
consola y no se desborda a lo ancho. Es barato y agarra lo que más duele.

### `dialogos.spec.ts` — los diálogos en pantalla baja
Corre a **1366×768**, la resolución de la máquina de la sucursal donde
aparecieron los problemas. En un monitor grande estos bugs no se ven. Verifica
que el diálogo no se derrame fuera de la ventana, que el botón de cerrar siga
alcanzable después de scrollear, y que el botón de guardar se pueda tocar.

### `pedidos-may.spec.ts` — un test por reclamo
Uno por cada cosa que reportó la clienta, para que no vuelva:
buscar un CUIT escrito con o sin guiones, que el error de duplicado diga de quién
es, que el buscador de presupuestos no esconda productos, que los precios salgan
con IVA incluido, que un remito de obra no exija cliente, y que se pueda ver qué
se cargó en un ingreso.

### `abmc.spec.ts` — alta, búsqueda, edición
Clientes y proveedores de punta a punta. Crean fichas marcadas `ZZ-E2E-…` para
que se distingan de datos reales de un vistazo.

## Reglas al escribir una prueba nueva

1. **Que falle antes de arreglar.** Una prueba que nunca vio el bug no prueba que
   el bug esté arreglado.
2. **Nada de `test.skip` silencioso por timing.** Si la grilla no cargó todavía,
   hay que esperarla; saltear la prueba finge cobertura que no existe.
3. **`toBeInViewport`, no `toBeVisible`.** El botón de los remitos existía en el
   DOM y hasta se podía clickear por código: estaba fuera de la pantalla. Para el
   usuario no existía.
4. **Probar lo que se ve, no lo que se guarda.** La clienta ve "157,66", no
   `precio_sin_iva = 130295.71`.

## Antes de tocar producción

1. `bun run test && bun run typecheck && bun run e2e` en verde.
2. La migración aplicada **primero en local**, y probada ahí con SQL: que haga lo
   que dice, que sea idempotente y que no rompa lo que ya andaba.
3. Contar en producción **qué filas va a tocar** antes de correrla.
4. Aplicar la migración, después desplegar el frontend.
5. Verificar contra producción con SQL de sólo lectura.

## Deuda conocida

- **146 labels sin asociar a su input** (`<Label>` sin `htmlFor`). Un lector de
  pantalla no anuncia el nombre del campo y hacer clic en la etiqueta no enfoca
  el input. Por eso las pruebas usan el helper `campo()` en vez de `getByLabel`.
- **`bun run lint` está roto**: hay tantos errores preexistentes que el formatter
  de ESLint revienta con `RangeError: Invalid string length`, y sale con código 0
  — o sea, da falso verde. No sirve para un CI hasta que se limpie.
- Las pruebas dependen de que la base local tenga datos (clientes, productos, un
  presupuesto). Con una base recién reseteada, algunas se saltean.
