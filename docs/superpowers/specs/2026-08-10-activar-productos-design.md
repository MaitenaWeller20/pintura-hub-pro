# Prender un producto apagado — 10/08/2026

La clienta cargó los precios de los productos KUM y siguen apareciendo
**Inactivo**. No es un bug de los precios: es que **no hay forma de prender un
producto desde la app**. El único camino que existe hoy es tan angosto que no
sirve para el caso que se dio.

## Cómo se llegó acá

Tres piezas que por separado están bien:

1. **La importación de stock/conteo da de alta los productos que faltan
   apagados**, a propósito, para que no se puedan vender sin precio
   (`crear_productos_faltantes`,
   `20260804200000_crear_productos_faltantes.sql:72`). Igual
   `crear_producto_desde_ingreso` (`20260724110000_ingresos_mercaderia_rpcs.sql:440`):
   `v_activo := v_precio > 0`.
2. **La importación de listas los destraba** cuando les llega el precio
   (`seDestraba`, `src/lib/importar-productos.ts:244`), pero exige que el precio
   guardado sea 0: *"a un producto apagado a propósito (que sí tiene precio) no
   se lo toca"*.
3. **"Cambiar precios" les puso el precio.** El RPC `cambiar_precios_masivo`
   (`20260804170000_descuento_por_producto.sql:183`) escribe `precio_sin_iva` y
   `markup_porcentaje` y **no toca `activo`** — no tiene por qué, no es su tema.

Los KUM de la foto tienen markup propio de 85,64% y origen "costo": pasaron por
(3). Resultado: **precio cargado y apagados**. Y como ya tienen precio, (2) no
los va a prender nunca más — la condición de `seDestraba` no se cumple.

El editor de producto tampoco ayuda: `ProductoDialog` manda
`activo: form.activo` (`productos.index.tsx:812`) pero **no tiene ningún control
para cambiarlo**. Sólo conserva lo que ya había. Y ninguna RPC reactiva uno
existente: `crear_producto_desde_ingreso` decide el `activo` del alta, no vuelve
sobre un producto que ya está.

O sea: el estado "apagado" es de ida. Se entra por los dos altas automáticas —la
importación de stock y el alta rápida de un ingreso sin precio— y no hay puerta
de salida. Mientras estén así no aparecen en `/ventas/nueva` (filtra `activo` y
`archivado`, `ventas.nueva.tsx:159-160`), así que **no se pueden vender**.

## Lo que se hace

Tres cosas: la puerta que falta, la versión masiva de esa puerta, y limpiar lo
que ya quedó mal.

### 1. Switch `Activo` en el editor de producto

Un `Switch` en `ProductoDialog`, abajo, al lado de Stock mínimo. Es el control
que la columna de la tabla ya está mostrando desde siempre.

**No se puede prender sin precio.** El switch queda deshabilitado —con el motivo
escrito, no mudo— si `precio_sin_iva <= 0`: un producto activo a $0 se vende
gratis, que es exactamente lo que las tres piezas de arriba están tratando de
evitar. Se habilita solo en cuanto se tipea un precio, porque lee `form`, no la
base.

**Tampoco se puede prender un archivado.** El botón de Editar aparece también
para los archivados, y un archivado+activo es una fila que dice "Archivado" y a
la vez está viva. Peor: `crear_venta` mira `activo` y **no** `archivado`
(`20260729210000_crear_venta_prelock_productos.sql:213`, y lo dice explícito
`20260729190000_eliminar_productos_con_presupuestos.sql:11`), así que la única
defensa es que la pantalla de ventas filtre. No hay que fabricar esa
combinación: si está archivado, el switch dice "restauralo primero".

Apagar siempre se puede. Es la mitad que no necesita guardas.

### 2. `Activar (N)` masivo

Botón en el header, admin, al lado de "Eliminar seleccionados", con la misma
forma: aparece cuando hay seleccionados y no se están viendo los archivados.
Engancha con el filtro **"Sin precio o apagados"** que ya existe: tildar todo y
prender de una es el flujo que la clienta necesita hoy.

Aparece **sólo si algún seleccionado está apagado** — un botón que siempre está
y casi nunca hace algo es ruido, y ya hay precedente de esa decisión en el
filtro de pendientes (`productos.index.tsx:440`).

**Va por RPC, no por `update` desde el cliente.** La primera versión de este spec
decía `.update().in("id", ids).select("id")`, y no aguanta el caso que tiene que
resolver: son ~650 productos, o sea ~24 KB de UUIDs **en la URL** del PATCH
(riesgo de 414 en el gateway), y encima `select()` lo trunca PostgREST en 1000
filas — este mismo archivo ya pagina las lecturas por ese motivo
(`productos.index.tsx:130`). Por POST con el array en el body no hay ninguno de
los dos problemas, y de paso el invariante queda del lado de la base y no sólo de
la pantalla.

Es además el patrón que ya tienen `eliminar_productos` y `restaurar_productos`:
RPC `SECURITY DEFINER` con chequeo de admin adentro + server fn en
`productos.functions.ts`.

```sql
activar_productos(p_ids uuid[]) RETURNS jsonb
  -- {activados: n, sin_precio: n, archivados: n}
```

Prende `id = ANY(p_ids) AND NOT activo AND NOT archivado AND precio_sin_iva > 0`.
Los tres predicados repiten las reglas del punto 1 del lado de la base: que la
pantalla no ofrezca prender un archivado no alcanza, la lista del cliente puede
estar vieja y los `id` viajan en el request.

Todo en **una sola sentencia** (CTE `MATERIALIZED` + UPDATE + los tres `count`),
porque contar antes y actualizar después son dos snapshots: entre uno y otro
alguien puede archivar o cargar un precio, y el toast mentiría. Y los que
**salta** hay que contarlos ANTES de prender, porque después no se distinguen de
los que ya estaban activos.

Devuelve **números, no listas**, al revés que `eliminar_productos`. Esa devuelve
los bloqueados con nombre porque son pocos; acá los saltados pueden ser 500 y no
caben en un toast. Para encontrarlos ya está el filtro "Sin precio o apagados".

El toast dice las dos cosas: `N activados` y, si hubo, `M sin precio (saltados)`,
con los números **que devolvió la base**, no los del snapshot de la pantalla.
Saltar en silencio dejaría a la clienta pensando que ya está.

### 3. El editor no puede guardar un producto activo a $0

Hoy sí puede: `ProductoDialog` arranca un producto nuevo con `activo: true` y
`precio_sin_iva: 0` (`productos.index.tsx:715-733`) y lo guarda así, sin ninguna
validación. Un switch deshabilitado no arregla un default que ya viene prendido.

El payload fuerza el invariante: `activo: form.activo && precio_sin_iva > 0`. Es
la misma cuenta que hace `crear_producto_desde_ingreso` (`v_activo := v_precio > 0`),
así que las tres altas del sistema pasan a decir lo mismo.

Un `CHECK (NOT activo OR precio_sin_iva > 0)` sería el arreglo de fondo, pero un
CHECK falla al crearse si hay UNA fila que lo viole, y no sabemos si en prod hay
activos a $0. No se agrega a ciegas en esta entrega; queda anotado.

### 4. Lo que ya quedó mal: lo prende la clienta, no un UPDATE a ciegas

**Cambio respecto de la primera versión del spec**, que traía una migración de
datos `UPDATE productos SET activo = true WHERE NOT activo AND NOT archivado AND
precio_sin_iva > 0`. Se cae por dos razones, y la segunda es la que decide:

1. El argumento que la justificaba —"hasta este deploy nada podía apagar un
   producto a propósito"— es cierto para la UI, pero un admin siempre pudo hacer
   `UPDATE` por la API o por el dashboard de Supabase. No hay auditoría de
   `activo`, así que **no hay forma de distinguir por SQL** un producto que la
   importación dejó apagado de uno que alguien discontinuó.
2. Y sobre todo: **contradice la decisión de no tocar `seDestraba`**. Si la razón
   para no dejar que una reimportación prenda cosas es que puede resucitar una
   baja intencional, un UPDATE masivo a ciegas hace exactamente eso, con menos
   contexto.

Con el botón del punto 2 en el mismo deploy, el arreglo lo hace una persona que
ve qué está prendiendo: filtro "Sin precio o apagados" → tildar todo → Activar,
y el toast dice cuántos. Dos clicks, y queda el número a la vista.

Antes de eso, contra la base de prod, se corre la consulta de revisión de
`docs/auditoria/activar-productos-2026-08-10.sql` para confirmar que lo apagado
con precio es efectivamente lo que entró por las altas automáticas (fecha de
creación, si tiene ventas) y no bajas viejas. Si apareciera algo raro, se
resuelve ahí y no después.

## Lo que NO se hace

**No se toca `seDestraba`.** Relajarlo a "inactivo + precio nuevo > 0" haría que
cualquier reimportación de lista vuelva a prender un producto que alguien apagó a
mano. Hoy ese razonamiento era teórico (nada podía apagar a mano); con el switch
pasa a ser real. La regla angosta es la correcta.

**No se toca `cambiar_precios_masivo`.** Sería consistente que también destrabe
(estaba apagado sólo por no tener precio, ahora tiene precio), y evitaría que
esto vuelva a pasar. Pero es el RPC que recalcula los precios de todo el
catálogo, y la clienta está bloqueada hoy: no se mete mano en el camino de la
plata en la misma entrega. Queda anotado como seguimiento. El costo de no
hacerlo es un paso manual visible (pill "Inactivo" + filtro + botón), no un
silencio.

**No se arregla que `crear_venta` no mire `archivado`.** Es una asimetría
conocida y documentada; toca ventas y presupuestos. El diseño de acá la respeta y
no la agranda. Ojo que `archivado = true, activo = true` **ya existe** en la base:
`eliminar_productos` archiva sin apagar. Es otra razón para que el masivo excluya
archivados en vez de asumir que no llegan.

**No se agrega el CHECK del invariante** (ver punto 3): habría que verificar
primero que no haya filas que lo violen en prod.

### El efecto lateral de que ahora se pueda apagar a mano

Con el switch, "apagado" deja de significar una sola cosa. Conviene tenerlo claro
porque decide cuándo una reimportación puede resucitar un producto:

- **Apagado y CON precio** = baja intencional. `seDestraba` no lo toca nunca. Es
  la garantía que se quería conservar y se conserva.
- **Apagado y SIN precio** = "le falta el precio", que es exactamente el estado en
  el que nacen los de las altas automáticas. Una lista que le traiga precio lo va
  a prender, y está bien que lo haga.

O sea que para discontinuar un producto se lo apaga y **se le deja el precio**. Si
además se le borra el precio, queda indistinguible de uno que nunca lo tuvo — y el
invariante del editor lo apaga solo si alguien pone el precio en 0. Es coherente,
pero no es obvio: queda escrito acá y cubierto por los tests de `seDestraba`
(`importar-productos.test.ts:367-379`).

## Lo que encontró la revisión de Codex sobre el spec

Cuatro cosas, dos de las cuales cambiaron el diseño:

1. **El `update` masivo desde el cliente no aguantaba el caso.** ~650 UUIDs en la
   URL de un PATCH (~24 KB, riesgo de 414) y `select()` truncado en 1000 filas por
   PostgREST, o sea que el número del toast podía ser mentira. De ahí la RPC.
2. **La migración de datos a ciegas.** Un admin siempre pudo apagar un producto
   por la API o el dashboard, y no hay auditoría de `activo` que permita
   distinguirlo. Y contradecía la cautela de no tocar `seDestraba`. Se reemplaza
   por el botón + la consulta de revisión contra prod.
3. **El editor ya podía guardar un producto activo a $0** (default `activo: true`
   + `precio_sin_iva: 0`), así que el switch deshabilitado no cerraba nada por sí
   solo. De ahí el punto 3.
4. Correcciones de hechos que no cambian el diseño: el estado apagado también se
   entra por el alta rápida de un ingreso sin precio (no sólo por la importación
   de stock), y `archivado + activo` ya existe en la base porque
   `eliminar_productos` archiva sin apagar.

Y confirmó que la RLS alcanza (un empleado no puede prender nada aunque llame la
API a mano), que `cambiar_precios_masivo` efectivamente no toca `activo`, que
`seDestraba` está bien descripta, y que activar no rompe ingresos en borrador ni
presupuestos abiertos.

## Lo que encontró la revisión del código

Tres cosas reales en la primera implementación, las tres arregladas. Las dos
primeras las encontraron Codex y el agente adversarial de SQL por separado, y
tienen test que las atrapa:

1. **El botón masivo le mandaba a la RPC sólo los que se podían prender.** Con 3
   con precio y 497 sin precio seleccionados, la RPC recibía 3, devolvía
   `sin_precio: 0` y el cartel decía "3 activados" a secas — justo lo que el punto
   2 dice que no puede pasar. Ahora se le manda la selección completa y la RPC es
   la que reparte. Menos código y números que no pueden mentir.
2. **El UPDATE comparaba `archivado` y `precio_sin_iva` contra el snapshot del
   CTE, no contra la fila viva.** Si otra sesión archivaba la fila (o le ponía el
   precio en 0) mientras la sentencia esperaba el lock, Postgres reevalúa el WHERE
   contra la versión nueva — pero preguntando por el valor viejo la reevaluación
   pasaba igual. Quedaba `activo + archivado`, o **activo a $0**: exactamente los
   dos estados que la función existe para evitar. Las tres condiciones pasaron a
   preguntarse sobre `p`, y `scripts/test-activar-concurrencia.sh` lo demuestra
   (con la versión vieja de la RPC, ese test falla 4 de 7).
3. **El UPDATE masivo no fijaba el orden de bloqueo.** Este repo ya se comió el
   deadlock por eso y lo resolvió siempre igual: bloquear en orden ascendente de
   `id` antes de tocar las filas (`crear_venta`,
   `20260729210000_crear_venta_prelock_productos.sql:162`; `eliminar_productos`,
   `20260724130000_eliminar_productos.sql:53`). Un UPDATE masivo sin prelock las
   bloquea en el orden que le dé el plan —físico, que con uuid no tiene relación
   con el id—, o sea a veces al revés que una venta concurrente. Se agregó el
   `PERFORM ... ORDER BY p.id FOR UPDATE`. Efecto lateral bueno: con las filas
   bloqueadas, los tres números pasan a ser exactos (antes, una fila que otra
   sesión archivaba en el medio no caía en ninguno de los tres).

   Esto no se puede probar con un test determinístico —el deadlock depende del plan
   que elija Postgres—, así que queda como argumento del invariante de orden más lo
   que sí verifica el test: los conteos exactos que el prelock hace posibles.

## Qué se prueba

Función pura `activables(seleccionados)` en `src/lib/productos-activar.ts`, que
parte la selección en "se prenden" y "sin precio", con tests:

- apagado con precio → se prende
- apagado sin precio (0, null) → saltado
- ya activo → no cuenta como prendido ni como saltado (seleccionar los 1104 tiene
  que decir "3 activados", no "1104")
- archivado con precio → no se prende
- selección vacía → nada, y el botón no aparece

Y `motivoNoActivar(form)` para el switch, misma regla, así el switch y el masivo
no pueden divergir (el riesgo real: es el mismo bug de las tres fórmulas de precio
que se desincronizaron, `productos.index.tsx:87`).

SQL, contra la base local: la RPC prende sólo lo que corresponde, cuenta bien los
saltados, la llama un empleado y explota, e `id` inexistente no rompe.

Playwright: producto apagado con precio → Editar → prender → guardar → el pill
desaparece y aparece en `/ventas/nueva`. Y el masivo: filtro "Sin precio o
apagados" → tildar todo → Activar → el toast dice cuántos y cuántos se saltaron.
