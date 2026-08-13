# Proveedor en productos: filtro y cambios de precio masivos — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec revisado con Codex (§10, 13 hallazgos incorporados). Pendiente: implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §3.
**Depende de:** `2026-07-29-precios-sugerido-publico-design.md` (la cadena de precios centralizada
en `src/lib/precios.ts`).

---

## 1. El problema

Lo que pidió el cliente, textual:

> *"KUM cambió la lista de precios, ahora le tienen que aumentar un 20%, a veces un 10%, entonces
> que se pueda seleccionar todos los productos de este proveedor para aplicarle el markup que sea."*

Hoy no se puede: los productos **no tienen proveedor**. `productos` tiene `categoria_id` y
`marca_id`, nada más. Los filtros de `/productos` son texto libre y categoría.

Existe `producto_codigos_proveedor`, pero responde otra pregunta —*"¿qué código usa ESTE proveedor
para ESTE producto?"*— y es una tabla de equivalencias para matchear remitos
(`20260724100000_ingresos_mercaderia_schema.sql:100`). Está vacía hasta que alguien carga un remito.

Hay un segundo problema, hermano: **`settings.descuento_proveedor_porcentaje` (42%) es global pero
es el descuento de Quimex.** Aplicárselo a los productos de KUM les rompe el costo.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Que cada producto sepa **de qué proveedor es**, y que los 1104 existentes queden etiquetados sin
   trabajo manual.
2. **Filtro por proveedor** en `/productos`.
3. Poder **mover los precios de todos los productos de un proveedor** de una sola vez, sin que se
   rompa a la mitad ni mienta sobre lo que hizo.
4. Que el **descuento comercial sea por proveedor**.

### No-objetivos (YAGNI)

- **Varios proveedores por producto.** El modelo mental del negocio es "este producto es de KUM".
  Ver §3.2 para la relación con `producto_codigos_proveedor`.
- **Historial de precios.** No existe y no se pidió. Lo que sí hace falta es que una operación
  masiva no se pueda aplicar dos veces por accidente (§6).
- **Recalcular retroactivamente al cambiar el descuento de un proveedor.** Se resuelve con una
  operación explícita (§6.3), no con un efecto mágico. Ver §4.1.
- **Listas de precios por proveedor como entidad.**

---

## 3. Un proveedor por producto

```sql
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS proveedor_id uuid REFERENCES public.proveedores(id);
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON public.productos (proveedor_id);

COMMENT ON COLUMN public.productos.proveedor_id IS
  'Proveedor cuya LISTA DE PRECIOS gobierna el costo de este producto. NO es "los proveedores a los que se les puede comprar": para eso está producto_codigos_proveedor, que es una tabla de equivalencias de códigos y admite varios proveedores por producto.';
```

Nullable. `ON DELETE` queda en `NO ACTION`: borrar un proveedor con productos tiene que fallar, no
dejar el catálogo huérfano en silencio.

### 3.1 Cómo se etiquetan los 1104 que ya están

Con un selector **"Proveedor de esta lista"** en la pantalla de importar. Encaja solo con el chunk
anterior: su §12 ya obliga a **reimportar la lista de Quimex una vez**. Eligiendo "Quimex" ahí, los
1104 quedan etiquetados en la misma pasada.

Es opcional, y **si no se elige, la clave se omite del payload**: no se pisa el proveedor que el
producto ya tenía. Es la misma regla que el chunk anterior aprendió a los golpes (§14.1 de aquel
spec): *la importación sólo escribe lo que la planilla —o la pantalla— realmente trae*.

El caché de catálogo de la importación (hoy trae `codigo`, `precio_sugerido_publico`,
`markup_porcentaje`) **suma `proveedor_id`**: se necesita para resolver el descuento efectivo de
cada producto (§4) cuando la pantalla no elige proveedor.

Además, un **"Asignar proveedor"** masivo desde `/productos`, para los que no vienen de ninguna
lista.

### 3.2 Por qué NO se fusiona con `producto_codigos_proveedor`

Son dos conceptos distintos y los dos hacen falta:

| | `productos.proveedor_id` | `producto_codigos_proveedor` |
|---|---|---|
| Responde | ¿qué lista gobierna su precio? | ¿qué código usa este proveedor para este producto? |
| Cardinalidad | uno | muchos por producto |
| La usa | el filtro y los cambios de precio | el matching de remitos al ingresar mercadería |

El `COMMENT` de §3 existe para que dentro de seis meses nadie use `proveedor_id` como "proveedores
posibles".

---

## 4. El descuento pasa a ser del proveedor

```sql
ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS descuento_porcentaje numeric(6,2)
    CHECK (descuento_porcentaje IS NULL OR (descuento_porcentaje >= 0 AND descuento_porcentaje < 100));

-- El global quedó sin tope (20260720100000_precios_descuento_proveedor.sql:20). Como
-- NULL en el proveedor significa "usá el global", un global de 142 vuelve a producir
-- costos negativos y deja el catálogo invendible (crear_venta los rechaza).
ALTER TABLE public.settings
  ADD CONSTRAINT settings_descuento_valido
    CHECK (descuento_proveedor_porcentaje >= 0 AND descuento_proveedor_porcentaje < 100);
```

El descuento efectivo:

```
proveedores.descuento_porcentaje  ??  settings.descuento_proveedor_porcentaje  ??  42
```

Misma escalera que ya usa el markup, así que no hay concepto nuevo. En `precios.ts`:

```ts
export function descuentoEfectivo(
  proveedor?: { descuento_porcentaje?: number | null } | null,
  settings?: { descuento_proveedor_porcentaje?: number | null } | null,
): number;
```

Un descuento de **0 es válido** (comprar a precio de lista) y NO debe caer al global: la escalera
pregunta por `null`, no por falsy. Es el mismo error que en el chunk anterior convertía un markup de
0% en 30%.

### 4.1 Cambiar el descuento de un proveedor NO recalcula nada

El costo está **materializado** en `productos.precio_fabrica`, no se deriva en runtime. Y Compras lo
usa como costo por defecto de cada ítem (`compras.nueva.tsx:105`). Recalcular 1104 costos como
efecto secundario de editar un campo del proveedor sería exactamente el tipo de sorpresa que este
proyecto ya se comió una vez.

Entonces, explícito: **cambiar el descuento afecta las importaciones y las altas futuras.** Para
llevar los costos ya guardados al descuento nuevo está la operación **"Recalcular el costo desde la
lista"** (§6.3): un acto deliberado, con vista previa y sobre una selección.

El formulario de proveedores muestra esa leyenda debajo del campo, no como letra chica.

### 4.2 Quién puede tocarlo

`proveedores` hoy es escribible por **cualquier usuario autenticado**
(`20260715100000_compras_proveedores_schema.sql:52`); el trigger `guard_proveedores_credito` sólo
protege la cuenta corriente. El descuento comercial define el costo de todo el catálogo de ese
proveedor: se suma al mismo trigger, con la misma regla (sólo admin lo cambia).

---

## 5. El filtro

Un `Select` de proveedores al lado del de categorías: *"Todos los proveedores"* + la lista + **"Sin
proveedor"** (si no, los que quedaron sin etiquetar son invisibles). Se combina con los filtros que
ya hay, en memoria, como los actuales.

La tabla suma la columna **Proveedor**. Para no volver a 13 columnas —que ya no entraban en la
notebook— se va **Marca**: casi ningún producto la tiene cargada (la lista de Quimex no la trae).

**El `select` de la query NO cambia de forma**: sigue trayendo `marca:marcas(id,nombre)` y suma
`proveedor:proveedores(id,razon_social,descuento_porcentaje)`. La búsqueda por texto sigue mirando
`marca?.nombre` (`productos.index.tsx:150`) y las exportaciones la siguen llevando: Marca sale de la
tabla, no de los datos.

---

## 6. Los cambios de precio masivos son una RPC transaccional

**No pueden ser N updates desde el cliente.** El camino actual escribe uno por uno
(`cobranzas.functions.ts`), y con 1104 productos son minutos: si se corta a la mitad, medio catálogo
queda a precio nuevo y medio al viejo, **sin ninguna marca de dónde se cortó** y sin historial para
reconstruirlo. Con "aumentar 20%" —que no es idempotente— eso es peor: reintentar no es seguro.

```sql
cambiar_precios_masivo(
  p_producto_ids    uuid[],
  p_operacion       text,     -- 'MARKUP' | 'AUMENTO' | 'RECALCULAR_COSTO'
  p_porcentaje      numeric,
  p_idempotency_key uuid
) RETURNS TABLE (actualizados int, sin_base int, precio_manual int, ya_aplicado boolean)
```

`SECURITY DEFINER`, **sólo admin**, una transacción. Propiedades que la hacen segura:

- **Atómica.** O se aplican todos o ninguno. No existe el estado "mitad y mitad".
- **Idempotente por clave.** La UI genera un uuid por operación; si la misma clave vuelve a llegar
  (doble click, reintento, F5), devuelve `ya_aplicado = true` y no toca nada. Es lo único que
  protege de aplicar "+20%" dos veces, que da +44% y no se puede deshacer.
- **Verifica el conteo.** Si los ids recibidos no matchean las filas afectadas, aborta. El chunk
  anterior encontró que PostgREST corta en 1000 sin avisar; en SQL eso no pasa, pero la verificación
  deja el contrato explícito.
- **Todo el cálculo en SQL**, con la misma cadena de precios. Sin round-trip por producto.

La tabla de claves usadas es mínima:

```sql
CREATE TABLE public.precio_operaciones (
  idempotency_key uuid PRIMARY KEY,
  operacion       text NOT NULL,
  porcentaje      numeric NOT NULL,
  productos       int  NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

Y de paso da lo más parecido a un historial que va a haber: *quién* movió los precios, *cuándo*, con
*qué* operación y sobre *cuántos* productos.

### 6.1 Cambiar el markup a X%

Lo que ya existe. Guarda `markup_porcentaje = X` y recalcula la venta. **Idempotente.**
Sirve para: *"a los de KUM les quiero ganar 40% en vez de 30%"*.

### 6.2 Aumentar los precios X%

Para: *"KUM mandó lista nueva, todo aumentó 20%"*.

Lo que se multiplica es **el precio de lista** — el número que el proveedor cambió. El costo se
**re-deriva**, no se multiplica:

```
precio_lista            × (1 + X/100)
precio_fabrica          = costoDeLista(precio_lista_nuevo, descuentoEfectivo(proveedor))
precio_sugerido_publico × (1 + X/100)      (si tiene)
markup                  sin tocar
→ el precio de venta sale de la cadena de siempre
```

Multiplicar el costo guardado sería propagar cualquier error que ya tuviera: un costo derivado con
el descuento global equivocado, o editado a mano. Re-derivarlo desde la lista lo deja bien.

**Si el producto no tiene precio de lista** (`precio_lista = 0`) pero sí costo, se multiplica el
costo: es la única base que hay. **Si no tiene ninguno de los dos**, se saltea y se cuenta en
`sin_base` — multiplicar cero da cero.

### 6.3 Recalcular el costo desde la lista

`precio_fabrica = costoDeLista(precio_lista, descuentoEfectivo(proveedor))`, sin tocar la lista.
**Idempotente.** Es la respuesta a "cambié el descuento de KUM del 42% al 35%" (§4.1), y también
arregla los costos que quedaron derivados con el descuento global equivocado.

### 6.4 Los precios puestos a mano no se pisan

El sistema deja escribir `precio_sin_iva` a mano, y sólo puede detectar *"no coincide con la
fórmula"* — no puede probar intención (`coincideConFormula`, §3.3 del spec anterior).

Regla: **las tres operaciones actualizan siempre los precios que vienen del proveedor** (lista,
costo, sugerido), y **recalculan la venta sólo si el precio guardado coincide con la fórmula**. Un
producto con precio a mano conserva su precio de venta, se le actualiza el costo igual —que es
información real del proveedor— y **se cuenta en `precio_manual`**.

El resultado se informa entero: *"1098 con precio recalculado · 4 tienen el precio puesto a mano y
se les dejó como estaba · 2 sin costo cargado"*. Nada silencioso en ninguna dirección.

### 6.5 Antes de aplicar, se ve qué va a pasar

El diálogo muestra el antes/después con los tres primeros de la selección:

```
ACRIL MEX NEGRO x4     lista  30.774,40 → 36.929,28     venta  44.681,78 → 53.618,14
ACRIL MEX NEGRO x20   lista 141.562,70 → 169.875,24    venta 205.536,63 → 246.643,96
...y 1101 productos más · 4 con precio a mano no se van a tocar
```

El botón dice la operación y el número, no "Aplicar": *"Aumentar 20% a 1104 productos"*.

---

## 7. Qué NO se toca

- `producto_codigos_proveedor` (§3.2).
- El stock.
- Las ventas ya emitidas y la facturación.
- La cadena de precios de `precios.ts`: se usa tal cual; sólo cambia de dónde sale el descuento.

---

## 8. Verificación

**Unit (`precios.test.ts`):** `descuentoEfectivo` con la escalera completa; un descuento de 0 del
proveedor NO cae al global; `null` sí.

**SQL (`scripts/test-precios-masivo.sh`, estilo `test-conteo-fisico.sh`):**
- Las tres operaciones sobre un set mixto (con/sin lista, con/sin sugerido, con/sin costo, con
  precio a mano) → cada contador da lo que corresponde.
- `AUMENTO` re-deriva el costo desde la lista nueva, no lo multiplica.
- `AUMENTO` dos veces con **la misma** idempotency key → `ya_aplicado`, nada cambia.
- `AUMENTO` dos veces con claves **distintas** → +44%. El test documenta que es una decisión del
  usuario, no un accidente del sistema.
- Un producto con precio a mano conserva su venta y actualiza su costo.
- Más de 1000 productos en un solo llamado: no se saltea ninguno.
- Un empleado no puede llamarla; tampoco puede cambiar `proveedores.descuento_porcentaje`.
- Un descuento de 142 en settings ya no se puede guardar.

**e2e (extendiendo `test-precios-sugerido-e2e.mjs`):** importar con proveedor elegido etiqueta todas
las filas; sin elegirlo no pisa el que había; el filtro por proveedor y "Sin proveedor" devuelven
los conjuntos correctos.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 9. Orden de implementación

1. Migración: `productos.proveedor_id` + índice + COMMENT, `proveedores.descuento_porcentaje` +
   CHECK, CHECK en el descuento global, guard de admin en el trigger de proveedores,
   `precio_operaciones`, y la RPC `cambiar_precios_masivo`. Regenerar `types.ts`.
2. `precios.ts`: `descuentoEfectivo` + tests.
3. Proveedores: campo de descuento con su leyenda.
4. Importar: selector de proveedor (sin pisar si no se elige) y `proveedor_id` en el caché.
5. `/productos`: filtro, columna Proveedor (sale Marca del render, no del select), "Asignar
   proveedor" masivo.
6. El diálogo de precios masivos: tres operaciones, vista previa, idempotency key. `aplicarMarkup`
   pasa a llamar a la RPC.
7. Tests SQL + e2e.

Del 1 al 5 nada cambia de comportamiento: mientras ningún producto tenga proveedor y ninguno tenga
descuento propio, todo sigue igual.

---

## 10. Hallazgos del review del spec con Codex

Trece hallazgos; todos incorporados. Los tres que cambiaron el diseño de fondo:

1. **Las operaciones masivas no podían ser N updates desde el cliente.** Sin transacción, un corte a
   la mitad deja medio catálogo aumentado y medio no, sin forma de saber cuál es cuál. Con una
   operación no idempotente eso es irreparable. → RPC transaccional con idempotency key (§6).
2. **Multiplicar `precio_fabrica` estaba mal.** Si hay precio de lista, el costo tiene que
   **re-derivarse** con el descuento efectivo; multiplicar el costo guardado propaga cualquier error
   que ya tuviera (un descuento global equivocado, una edición a mano). → §6.2.
3. **El descuento por proveedor estaba a medio diseñar.** Faltaba decir qué pasa con los costos ya
   materializados al cambiarlo (Compras los usa como default), y faltaba rastrear los tres lugares
   que leen el global. → §4.1 lo hace explícito y agrega "Recalcular el costo" como respuesta
   deliberada.

Los otros: los precios puestos a mano se pisaban sin avisar (§6.4); cualquier empleado podía cambiar
el descuento comercial (§4.2); el descuento global seguía sin `CHECK`, así que un 142 volvía a
producir costos negativos (§4); el caché de la importación necesitaba `proveedor_id` (§3.1); los
productos con `precio_fabrica = 0` había que saltearlos, no multiplicarlos por cero (§6.2); sacar
Marca de la tabla no podía sacarla del `select` o rompía la búsqueda y las exportaciones (§5); y
había que documentar la semántica de `proveedor_id` para que nadie la confunda después con
"proveedores posibles" (§3.2).

Un hallazgo del review no era del spec sino del código **que ya está en producción**:
`aplicarMarkup` **ignoraba el error del `UPDATE`**, así que una escritura fallida se contaba como
exitosa y el cartel decía que se habían recalculado precios que en realidad quedaron viejos. Se
arregló aparte (commit `0d82a6c`), sin esperar a este chunk.
