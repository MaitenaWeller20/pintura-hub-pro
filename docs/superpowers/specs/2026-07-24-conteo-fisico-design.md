# Carga del stock real: conteo físico — Diseño

**Fecha:** 2026-07-24
**Estado:** Implementado y verificado (unit + e2e SQL + concurrencia + Playwright). Spec revisado con Codex (§11); código revisado con Codex y agentes adversariales (§12). Pendiente: deploy.
**Viene de:** `2026-07-24-stock-no-es-envase-design.md` (§4, no-objetivos). Aquella corrección dejó
el inventario de producción casi en cero a propósito; esto es cómo lo vuelve a llenar la clienta.

---

## 1. El problema

Después de la corrección del envase, en producción hay **1157 productos** y **~9 filas** de
`stock_sucursal` con cantidad distinta de cero. La clienta tiene que cargar el inventario real, y
hoy no puede:

- **`/stock` sólo lista filas de `stock_sucursal`.** Un producto que nunca tuvo stock no tiene fila,
  así que **no aparece en Inventario**. No se puede ni buscar para ajustarlo.
- El único camino que crea la fila es un Ingreso de mercadería o una Compra: documentos de
  proveedor. Para un conteo físico de lo que ya está en el depósito no sirve — no hay remito que
  cargar.
- Aunque apareciera, el ajuste es **de a un producto por vez**, con un diálogo modal y un motivo
  cada uno. Para ~1150 productos son ~1150 diálogos.

Hay además un defecto latente que este trabajo no puede ignorar: **PostgREST devuelve como máximo
1000 filas** y ninguna pantalla pagina. `/productos` ya está truncando en silencio (dice
"1000 de 1000" con 1133 productos en la base local). En un listado de catálogo es molesto; en una
**planilla de conteo físico es peligroso**: un producto que no aparece se lee como "no existe" y su
stock queda sin cargar para siempre, sin ningún aviso.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Que **Inventario liste todos los productos**, tengan o no fila de stock, y que se distinga
   "nunca lo conté" de "lo conté y no hay".
2. Un **modo conteo físico**: cargar cantidades de muchos productos en una pasada y confirmarlas de
   una, en una transacción, con kardex por producto.
3. Que ninguna de las dos cosas **trunque en silencio**.

### No-objetivos (YAGNI)

- **Importar stock desde una planilla.** El motor queda hecho (la RPC masiva); lo que faltaría es
  una pantalla de mapeo. No se hace ahora, y si se hace va con su columna de stock explícita y por
  la RPC — nunca repitiendo el upsert directo que causó el bug del envase.
- **Cambiar quién ajusta stock.** Sigue siendo solo-admin, igual que `ajustar_stock`. Cambiar eso es
  una decisión de la clienta, no técnica.
- **Conteo por lotes / vencimientos / ubicación de depósito.** El modelo de stock es una cantidad
  por producto y sucursal; no se toca.
- **Una app de conteo con lector de código de barras.** Sería lo cómodo, pero no hay lector ni
  códigos impresos; el flujo real es planilla en papel (§3).

---

## 3. Cómo se va a usar (el flujo real)

1. Ella entra a **Inventario**, elige la sucursal y aprieta **Imprimir PDF**: sale la planilla con
   todos los productos, su envase y una columna **Contado** en blanco.
2. Recorre el depósito y anota a mano.
3. Vuelve, aprieta **Conteo físico**, y la columna Cantidad se vuelve editable. Tipea lo que contó.
   Puede filtrar por texto o por "sin cargar" para ir por partes, y guardar varias veces.
4. **Guardar**: una sola llamada, una transacción, un movimiento de kardex por producto que cambió.

El punto 3 es el que define el diseño: se carga **de a muchos**, se puede hacer **en varias
sesiones**, y lo que no se toca **no se toca**.

---

## 4. Fix A — Inventario lista todos los productos

`/stock` deja de consultar `stock_sucursal` y pasa a consultar **`productos`** con el stock
embebido:

```ts
supabase.from("productos")
  .select("id,codigo,nombre,stock_minimo,unidad_medida,tamano_envase,
           categoria:categorias(nombre), marca:marcas(nombre),
           stock_sucursal(cantidad,sucursal_id)")
  .eq("archivado", false)
```

- Con una sucursal elegida: **una fila por producto**, con la cantidad de esa sucursal o "sin
  cargar".
- Con "todas las sucursales" (sólo admin): una fila por producto **y** sucursal, como hoy.
- Los archivados siguen ocultos.

### 4.1 "Sin cargar" no es lo mismo que "sin stock"

La tentación es decir "sin fila = sin cargar", y está **mal**: la corrección del envase
(`20260724150000`) puso 113 filas en 0 con un `UPDATE`, **sin** kardex a propósito. Esas filas
existen y valen 0, pero nadie las contó nunca. Si "sin cargar" se definiera por la existencia de la
fila, esos 113 productos —justo los que hay que contar— desaparecerían del filtro.

El criterio correcto es **el kardex**: una fila está cargada cuando existe al menos un
`stock_movimientos` para ese par (producto, sucursal). Todo lo que entró por una vía legítima
—ajuste, venta, compra, remito, ingreso, y de ahora en más el conteo— deja movimiento; lo que
nunca se tocó, no.

| Situación                                                     | Estado                |
| ------------------------------------------------------------- | --------------------- |
| Sin fila, **o** con fila pero sin ningún movimiento de kardex | **Sin contar** (gris) |
| Con kardex y `cantidad = 0`                                   | **Sin stock** (rojo)  |
| Con kardex y `0 < cant ≤ mínimo`                              | **Bajo** (ámbar)      |
| Con kardex y `cant > mínimo`                                  | **OK** (verde)        |

La distinción importa: son ~1150 productos sin contar y ~9 con stock real, y mezclarlos hace
imposible saber qué falta. Se agrega el filtro **"Sin contar"** al lado de "Solo stock bajo".

Para no pagar un `EXISTS` por fila desde el cliente, esto se resuelve con una **vista**
`stock_inventario` (`security_invoker = true`): productos activos × sucursales, con la cantidad, el
envase, el mínimo y el flag `tiene_movimientos`. La pantalla lee de ahí.

**Efecto colateral deseado en el dashboard**: el KPI de stock bajo pasa a ignorar los "sin contar",
así que deja de estar disparado con productos que nadie contó nunca.

### 4.2 Nada de truncar en silencio

Se lee en páginas explícitas con `.range(desde, hasta)` hasta que una página vuelva incompleta, en
un helper reusable (`src/lib/supabase-paginado.ts`), con un tope duro de seguridad.

**La regla que hace que esto sea correcto es el orden.** Sin un `order` por una columna **única y
estable**, PostgREST no garantiza el mismo orden entre requests y la paginación por offset puede
saltear o repetir filas. Todas las consultas paginadas ordenan por una clave total (`codigo, id` en
el inventario; `nombre, id` en el catálogo). Queda dicho en el comentario del helper, porque el
próximo que lo use se va a olvidar.

El helper devuelve además si se alcanzó el tope, y la pantalla lo **dice** en vez de mostrar una
lista incompleta como si fuera completa.

Se aplica en tres lugares:

- **`/stock`** — el objetivo de este trabajo.
- **`/productos`** — ya está truncando hoy (muestra "1000 de 1000" con 1133 productos).
- **`/ventas/nueva`** — trae todos los productos para el buscador **sin paginar**. Con 1157
  productos activos en producción, **los que quedan después del 1000 no se pueden vender**. No es
  parte del conteo, pero es una consecuencia directa del volumen que dejó la importación y arreglarlo
  cuesta las mismas dos líneas.

---

## 5. Fix B — el conteo es una entidad, no un lote de ajustes

Tres problemas distintos (idempotencia, "¿esto ya se contó?", y qué pasa si se vende en el medio)
se resuelven con la misma idea: **un conteo es un documento**, igual que una venta o un ingreso.

### 5.1 Tablas nuevas

```
stock_conteos        id, sucursal_id, usuario_id, motivo, contado_desde, idempotency_key (unique),
                     items_ajustados, items_sin_cambio, items_con_movimientos, created_at
stock_conteo_items   id, conteo_id, producto_id, cantidad_contada, cantidad_anterior,
                     movimientos_posteriores, cantidad_final
```

`GRANT SELECT` a `authenticated` con RLS por sucursal, escritura exclusiva por la RPC. Mismo
criterio que `compras` e `ingresos_mercaderia`.

### 5.2 `ajustar_stock_masivo`

`ajustar_stock_masivo(p_sucursal_id, p_items jsonb, p_motivo, p_contado_desde, p_idempotency_key)`,
`SECURITY DEFINER`, admin-only, mismo patrón que `ajustar_stock` (`20260714260000`).

**Validaciones**: `auth.uid()` no nulo y admin; motivo obligatorio; sucursal existente; `p_items` no
vacío y con tope (§7); por ítem `producto_id` existente y **no archivado**, `cantidad` no nula, no
negativa, finita; **ningún `producto_id` repetido** en el payload.

**Idempotencia real**, igual que `crear_venta` y `confirmar_ingreso_mercaderia`:
`pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0))` + short-circuit si ya existe
un conteo con esa clave, devolviendo su resultado guardado sin tocar nada. El "si el delta es 0 no
escribo" **no alcanza** como idempotencia: si el primer request guardó 10, se perdió la respuesta,
entró una venta que dejó 9, y el retry manda el mismo payload, sin clave volvería a poner 10.

### 5.3 Anti-deadlock: un lock de tabla, no un orden de filas

El plan original —bloquear las filas ordenadas por `producto_id`— **no sirve**, y conviene decir por
qué: las otras RPC que mueven stock recorren sus ítems en el orden del payload
(`crear_venta`, `aprobar_remito`) o por número de línea (`confirmar_ingreso_mercaderia`), no por
`producto_id`. Un conteo que bloquea A y espera B, contra una venta que bloqueó B y espera A, es un
deadlock: Postgres aborta una de las dos.

Imponer un orden global en **todas** las RPC de stock sería el arreglo canónico, pero es cirugía
sobre `crear_venta`/`aprobar_remito`/`confirmar_ingreso_mercaderia` —el corazón transaccional del
sistema— para un caso que ocurre una vez cada tanto. No lo vale.

La salida barata y exacta: el conteo abre con

```sql
LOCK TABLE public.stock_sucursal IN SHARE ROW EXCLUSIVE MODE;
```

antes de tocar ninguna fila. Ese modo choca con el `ROW EXCLUSIVE` que toman los `INSERT`/`UPDATE`
de las demás RPC, así que **no puede haber ciclo**: el conteo pide un único lock al principio, sin
tener nada tomado, y una vez que lo tiene nadie más escribe stock hasta que commitea. Es el mismo
recurso que usa la migración de corrección del envase. El costo es que un conteo bloquea las ventas
mientras corre; con ~1157 productos eso es menos de un segundo (§7), y frenar la caja un segundo
durante un inventario es aceptable.

### 5.4 Qué pasa si se vende durante el conteo

El papel dice "a las 10:00 había 10". Si a las 10:10 se venden 2 y ella guarda a las 10:30, escribir
10 **borra la venta del inventario**. Es exactamente la clase de mentira que acabamos de sacar del
sistema, así que no se hace.

La pantalla manda `contado_desde` = el momento en que se **abrió** el modo conteo. Para cada
producto, la RPC calcula:

```
cantidad_final = cantidad_contada + Σ(delta de stock_movimientos de ese producto+sucursal
                                       con created_at >= contado_desde)
```

En el ejemplo: `10 + (−2) = 8`. La venta sobrevive. El supuesto explícito es _"lo contado refleja el
estado al abrir el conteo"_, que es el supuesto estándar y el único que se puede sostener sin
pedirle la hora de cada renglón.

Los ítems donde ese ajuste se aplicó se cuentan aparte (`items_con_movimientos`) y la pantalla lo
dice: "en N productos se aplicaron movimientos posteriores al conteo".

Si `contado_desde` viene NULL, es un ajuste absoluto puro (el comportamiento de `ajustar_stock`).

### 5.5 Escritura

Dentro de la transacción, después del `LOCK TABLE`:

1. `INSERT ... ON CONFLICT DO NOTHING` para garantizar la fila (igual que `ajustar_stock`).
2. `SELECT ... FOR UPDATE` y cálculo del delta **contra la fila bloqueada**, nunca contra lo que el
   cliente creía que había.
3. Si la cantidad final **es igual** a la actual: se registra el ítem en `stock_conteo_items` (sí se
   contó) pero **no** se escribe ni `stock_sucursal` ni kardex. Diferencia deliberada con
   `ajustar_stock`, que siempre escribe un movimiento aunque el delta sea cero: en un conteo de 1157
   productos, la mayoría no cambia y el kardex quedaría inservible.
4. Si cambió: `UPDATE` + `INSERT` en `stock_movimientos` con tipo `AJUSTE`, delta, cantidad anterior
   y nueva, el motivo y el `usuario_id`.

Devuelve `{ conteo_id, ajustados, sin_cambio, con_movimientos }`.

---

## 6. Fix C — el modo conteo en la pantalla

Botón **"Conteo físico"** en el header de `/stock`.

- **Exige una sucursal elegida.** Contar "todas" no significa nada: si está en "Todas", el botón
  pide elegir una primero.
- Al activarlo, la columna Cantidad se vuelve un input numérico por fila, precargado **vacío** (no
  con la cantidad actual: lo que se deja vacío no se toca, y precargarlo invitaría a confirmar sin
  haber contado).
- Al lado de cada input se sigue viendo la cantidad actual, en gris, para comparar.
- Barra fija abajo: `N productos cargados · [Motivo: Conteo físico] · Guardar · Cancelar`.
- **Guardar** manda sólo las filas con valor. **`0` es un valor**: "lo conté y no hay" es
  justamente el dato que hay que poder cargar, así que el criterio de envío es _"el input no está
  vacío"_, nunca un `if (cantidad)` que se comería los ceros. Tiene test propio.
- Toast: "N ajustados, M sin cambio" y, si hubo, "en K se aplicaron movimientos posteriores al
  conteo" (§5.4).
- **Cancelar** con cambios sin guardar pide confirmación.
- Los filtros y el buscador siguen vivos en modo conteo, y **lo tipeado no se pierde** al filtrar
  (el estado vive en un `Map` por `producto_id`, no en la fila renderizada).
- Se usa `NumberInput` (el del repo), que ya maneja la coma decimal argentina.

### 6.1 El PDF: la planilla de conteo

El `Imprimir PDF` de Inventario agrega una última columna vacía, **Contado**, para escribir a mano.

Y arregla una trampa que ya tenía: **imprime `filtered`**, o sea lo que se está viendo. Con un
filtro o una búsqueda activos, sale una planilla parcial que parece completa — y en un conteo eso
significa no contar el resto. El PDF pasa a decir en el título cuántas filas de cuántas lleva y, si
hay filtros activos, que es una **vista filtrada**.

---

## 7. Volumen, tope y rendimiento

1157 productos × 1 sucursal = 1157 filas con un input cada una, y una transacción que puede tocar
1157 filas de stock más su kardex mientras **tiene bloqueada la escritura de `stock_sucursal`**
(§5.3). Las dos cosas hay que medirlas, no suponerlas:

- **La RPC**: se mide con 1157 y con el tope, contra la base local, y se verifica que una venta
  concurrente **espera y termina bien** (no que falla). Si el tiempo con el lock tomado se fuera de
  un par de segundos, el diseño cambia a lotes por sucursal.
- **La pantalla**: se mide tipeando con la lista real cargada. Las filas se memoizan y el estado de
  lo tipeado vive en un `Map` por `producto_id` fuera de la fila, así que re-renderizar una fila no
  arrastra a las otras. Si aun así laggea, la salida es virtualizar la tabla — **no** paginar la UI,
  que en un conteo invita a perder lo cargado.

El **tope de ítems** se fija en **2000**: cubre con margen el catálogo real por sucursal (1157) y
deja afuera un payload absurdo. No es un número mágico sino el resultado de la medición; queda
anotado en el comentario de la RPC junto con lo que tardó.

Decisión explícita: **no se virtualiza de entrada**. Primero medir.

---

## 8. Seguridad

- La RPC nueva es `SECURITY DEFINER` con `REVOKE ALL FROM public` + `GRANT EXECUTE` a
  `authenticated` y `service_role`, igual que las demás, y valida admin adentro.
- No cambia ningún grant de `stock_sucursal`: sigue cerrada a escritura directa (esa es justamente
  la invariante que dejó el fix anterior: el stock sólo se mueve por RPC con kardex).
- Las tablas nuevas: `GRANT SELECT` a `authenticated` con RLS por sucursal, `GRANT ALL` a
  `service_role`, escritura exclusiva por la RPC.
- La vista `stock_inventario` va con `security_invoker = true`, así respeta las policies de quien
  consulta en vez de las del dueño.
- El frontend llama por un server function (`src/lib/stock.functions.ts`) con el middleware de auth,
  como `ajusteStock`.

**Lo que NO se arregla acá, y conviene no venderlo como garantía:** el selector "Todas las
sucursales" es solo-admin **en la UI**, pero la policy de lectura de `stock_sucursal` es
`USING (true)`, así que un empleado que llame la API directo ve el stock de las dos sucursales. Es
preexistente, no lo introduce este cambio, y cerrarlo es una decisión de la clienta (hoy el sistema
asume que el stock global no es información sensible entre sucursales de la misma empresa).

---

## 9. Verificación

- **Unit** del helper de paginación: junta varias páginas; corta cuando la página viene incompleta;
  avisa cuando toca el tope.
- **e2e SQL** contra la base local, sobre la RPC:

  | #   | Escenario                                                                        | Esperado                                                   |
  | --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
  | a   | producto sin fila de stock                                                       | crea la fila, deja la cantidad y **un** movimiento         |
  | b   | cantidad igual a la actual                                                       | **no** escribe: ni stock ni kardex                         |
  | c   | mezcla de cambios y no-cambios                                                   | `{ajustados: k, sin_cambio: j}` correcto                   |
  | d   | correr el mismo payload dos veces                                                | la segunda no agrega movimientos                           |
  | e   | `producto_id` repetido en el payload                                             | rechaza                                                    |
  | f   | cantidad negativa / NULL / no numérica                                           | rechaza                                                    |
  | g   | producto archivado                                                               | rechaza                                                    |
  | h   | producto inexistente / sucursal inexistente                                      | rechaza                                                    |
  | i   | motivo vacío                                                                     | rechaza                                                    |
  | j   | payload vacío o por encima del tope                                              | rechaza                                                    |
  | k   | usuario no admin                                                                 | rechaza                                                    |
  | l   | el kardex queda con delta, anterior, nueva, motivo y usuario                     | correcto                                                   |
  | m   | dos conteos concurrentes sobre los mismos productos                              | se serializan, sin deadlock ni lost-update                 |
  | n   | conteo concurrente con una **venta** que toca los mismos productos en otro orden | la venta **espera** y termina bien; no hay deadlock (§5.3) |
  | o   | `cantidad_contada = 0` sobre un producto sin fila                                | crea la fila en 0 **y** deja constancia del conteo         |
  | p   | hubo una venta **después** de `contado_desde`                                    | la cantidad final suma ese movimiento (§5.4)               |
  | q   | repetir la misma `idempotency_key`                                               | devuelve el resultado del primer conteo, sin tocar stock   |
  | r   | 1157 ítems (el catálogo real)                                                    | mide cuánto tarda con el `LOCK TABLE` tomado               |
  | s   | "Sin contar" sobre una fila que la corrección del envase dejó en 0 sin kardex    | sigue siendo **Sin contar**                                |

- **typecheck** + suite completa en verde.
- **Review adversarial** con subagentes + **review con Codex** del diff.
- **Playwright** con la lista real: importar 1103 productos, ver que aparecen **todos** en Inventario
  como "Sin contar" (y que el número que muestra la pantalla coincide con el `count` de la base),
  cargar un puñado por conteo —incluido un **0**—, y verificar en la base la cantidad y el kardex.
  Verificar también que `/productos` y el buscador de `/ventas/nueva` dejan de truncar.
- **Deploy**: `migration list` → `db push --dry-run` → push → verificación → `vercel --prod`.
  Chequear además que el **Max Rows** de PostgREST en prod sea ≥ 1000 (Supabase → Settings → API;
  el default es 1000): es la invariante de la que depende que la paginación no saltee filas.

---

## 10. Orden de implementación

1. Helper de paginación + sus tests. ✅
2. Migración: vista `stock_inventario`, tablas del conteo, `ajustar_stock_masivo` + e2e SQL.
3. Server function y `/stock`: listar todos los productos, estado "Sin contar", filtro nuevo,
   paginación.
4. Modo conteo + la planilla en PDF.
5. `/productos` y `/ventas/nueva` dejan de truncar.
6. Verificación (§9), reviews, commit, producción.

---

## 11. Hallazgos del review del spec con Codex

**Incorporados:**

1. **CRÍTICO — la garantía anti-deadlock era falsa.** Ordenar los ítems por `producto_id` no sirve
   porque las otras RPC bloquean en el orden de su payload (`crear_venta`, `aprobar_remito`) o por
   número de línea (`confirmar_ingreso_mercaderia`). Reemplazado por un `LOCK TABLE ... SHARE ROW
EXCLUSIVE` al principio de la transacción, que hace imposible el ciclo sin tocar el resto de las
   RPC (§5.3). Se agrega el test conteo-vs-venta (escenario n), no sólo conteo-vs-conteo.
2. **CRÍTICO — la cantidad absoluta borraba ventas hechas durante el conteo.** Contar 10 a las
   10:00, vender 2 a las 10:10 y guardar a las 10:30 dejaba 10 en vez de 8. Ahora la pantalla manda
   `contado_desde` y la RPC suma los movimientos posteriores (§5.4).
3. **CRÍTICO — el "delta cero no escribe" no es idempotencia.** Sólo cubre el doble submit inmediato;
   con una venta en el medio, un retry pisaba el stock. Se agrega `idempotency_key` con advisory
   lock y short-circuit, igual que `crear_venta` e `ingresos` (§5.2).
4. **CRÍTICO — "tiene fila = está contado" es falso.** La corrección del envase dejó 113 filas en 0
   **sin** kardex; con el criterio viejo esos productos —justo los que hay que contar— desaparecían
   del filtro "Sin cargar". Ahora el criterio es la existencia de kardex, servida por la vista
   `stock_inventario` (§4.1).
5. **IMPORTANTE — a la paginación le faltaba el orden estable.** Sin un `order` por una clave única,
   la paginación por offset puede saltear o repetir filas. Documentado en el helper y aplicado en
   todas las consultas paginadas (§4.2).
6. **IMPORTANTE — el filtro por sucursal sobre la tabla embebida.** Con `!inner` desaparecerían
   justamente los "sin contar". Resuelto de raíz con la vista, que ya trae producto × sucursal.
7. **IMPORTANTE — el tope de 5000 era arbitrario y podía chocar con el `statement_timeout`.** Bajado
   a 2000 y, sobre todo, convertido en un número medido (§7, escenario r).
8. **IMPORTANTE — el PDF imprimía la vista filtrada** sin decirlo: en un conteo eso es una planilla
   parcial que parece completa. Ahora el título dice cuántas de cuántas y si hay filtros (§6.1).
9. **IMPORTANTE — el `0` se podía perder.** "Lo conté y no hay" es el dato más importante del
   conteo; el criterio de envío es "el input no está vacío", con test propio (§6, escenario o).
10. **MENOR — `ajustar_stock` sí escribe kardex con delta cero**, así que omitirlo en la masiva es
    una diferencia deliberada, no una equivalencia. Documentado en §5.5.
11. **MENOR — `/ventas/nueva` también trae los productos sin paginar**: con 1157 activos, los
    posteriores al 1000 **no se pueden vender**. Entra en el alcance porque cuesta lo mismo y es una
    consecuencia directa del volumen que dejó la importación (§4.2).

**Anotado sin cambiar:** que "Todas las sucursales" sea solo-admin es UI, no seguridad — la policy
de lectura de `stock_sucursal` es `USING (true)`. Es preexistente y su cierre es decisión de la
clienta; queda dicho en §8 para no venderlo como garantía.

---

## 12. Hallazgos del review del CÓDIGO (Codex + agentes adversariales)

Codex sobre el diff, cinco agentes en paralelo con verificación adversarial (26 crudos → 2
confirmados que no se solapaban con Codex), y la prueba en Playwright. Todo incorporado.

**CRÍTICO**

1. **La FK del conteo hacía imborrables los productos contados en cero.** `stock_conteo_items`
   referenciaba `productos` con FK restrictiva. Un producto contado en 0 (que no deja kardex)
   quedaba con un `stock_conteo_items` y `eliminar_productos` —que lo borra de verdad porque no
   tiene historial— tiraba `foreign_key_violation` y abortaba el lote entero. **Reproducido** en
   la base local. Igual trampa que ya habíamos evitado con el kardex en la corrección del envase.
   Arreglo: FK `ON DELETE SET NULL` + código/nombre desnormalizados (el conteo es auditoría,
   sobrevive al producto sin impedir su borrado). Test (t).

2. **La `idempotency_key` se generaba dentro del `mutationFn`.** Un doble click o un reintento de
   react-query generaban claves distintas → dos conteos, y con `contado_desde` fijo el segundo
   sumaba el ajuste del primero como "movimiento posterior" y duplicaba el stock. Arreglo: la
   clave se genera una vez (ref estable) y se rota recién al guardar OK.

3. **`contado_desde` venía del reloj del navegador.** Si estaba desfasado respecto del servidor,
   la suma de movimientos posteriores se calculaba sobre la ventana equivocada. Arreglo: RPC
   `iniciar_conteo_stock()` que devuelve `now()` del servidor; la pantalla usa eso. Si falla,
   `contado_desde` queda NULL (ajuste absoluto), nunca la hora local.

4. **El clamp de negativo a cero era silencioso.** Si se vendía más de lo contado durante el
   conteo, la cantidad final daba negativo y se subía a 0 sin avisar. Arreglo: se sigue dejando
   en 0 (el stock no puede ser negativo) pero se cuenta como **conflicto** y se informa en
   pantalla. Test (u).

**IMPORTANTE**

5. **`crypto.randomUUID()` no existe en contexto no seguro** (http por IP en la LAN, no
   localhost): el flujo entero quedaría inutilizable justo donde la clienta lo va a usar. Arreglo:
   helper `uuidv4()` con fallback a `crypto.getRandomValues`. Con tests.

6. **La pantalla no memoizaba las filas**: tipear en un input re-renderizaba las 2266. Arreglo:
   `InventarioRow` con `React.memo`, valor por fila y callbacks estables. **Medido** en Playwright
   con la lista real: ~11 ms por tecla con 1133 inputs montados.

7. **Truncado silencioso si el `db-max-rows` de prod fuera menor que el tamaño de página.** La
   detección "página incompleta = última" sólo vale si el server nunca recorta por debajo de lo
   pedido. Arreglo: los callers piden `{ count: 'exact' }` y el helper marca `truncado` si juntó
   menos que el total real — así, aunque el cap sea menor, la lista nunca queda "silenciosamente
   incompleta". Se verifica el `db-max-rows` de prod en el deploy.

8. **El PDF imprimía la vista filtrada** sin decirlo. Arreglo: el título dice "N de M ítems" y, si
   hay filtros, "VISTA FILTRADA".

9. **Cuatro aserciones de rechazo eran falsos verdes**: el mensaje centinela `FALLA` contenía la
   palabra que el guard buscaba, así que un caso donde la RPC _no_ rechazara se tragaba a sí mismo
   y daba verde. Arreglo: centinela `NO-RECHAZO` que no comparte texto con el guard, y el guard
   re-lanza ante él. **Verificado** con un meta-test que fuerza el no-rechazo.

**MENOR**

10. **`NumberInput` podía dejar el valor viejo** al escribir un separador suelto (`,`). Arreglo:
    sin ningún dígito, emite `null`.
11. **El comentario decía "productos activos"** pero la vista incluye a propósito los inactivos
    no archivados (importados sin precio pueden tener stock). Corregido el comentario.

**El bug que encontró Playwright y ningún review:** el `z.string().datetime()` de la server
function rechazaba el timestamp de `iniciar_conteo_stock` porque PostgREST lo serializa con offset
`+00:00` y Zod estricto exige `Z`. Guardar tiraba silencioso. Se relajó la validación (el valor lo
genera el server y lo castea la RPC). Sin la prueba end-to-end esto llegaba a producción.

**Verificado end-to-end en Playwright** con la lista real (1133 productos): todos aparecen como
"Sin contar", el modo conteo levanta 1133 inputs, cargar (incluido un 0) y guardar deja la cantidad
con kardex, hora del servidor y clave de idempotencia, el producto pasa a "cargado", y `/productos`
muestra "1133 de 1133" (antes truncaba en 1000).

**Descartados (17):** entre otros, que el `LOCK TABLE` pudiera colgar la RPC, que el orden paginado
no fuera total, que PostgREST no filtrara por la columna calculada `cargado` (sí lo hace), y que el
signo de `stock_movimientos.cantidad` fuera inconsistente entre RPC (es delta con signo en todas).
