# Proveedor en productos: filtro y cambios de precio masivos — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec escrito. Pendiente: review con Codex, implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §3.
**Depende de:** `2026-07-29-precios-sugerido-publico-design.md` (la cadena de precios ya centralizada
en `src/lib/precios.ts`).

---

## 1. El problema

Lo que pidió el cliente, textual:

> *"KUM cambió la lista de precios, ahora le tienen que aumentar un 20%, a veces un 10%, entonces
> que se pueda seleccionar todos los productos de este proveedor para aplicarle el markup que sea."*

Hoy eso **no se puede hacer**: los productos no tienen proveedor. `productos` tiene `categoria_id` y
`marca_id`, nada más. Los filtros de `/productos` son texto libre y categoría.

Existe `producto_codigos_proveedor` (de Ingresos de mercadería), pero responde otra pregunta: *"¿qué
código usa ESTE proveedor para ESTE producto?"*. Es una tabla de equivalencias para matchear
remitos, no una respuesta a *"¿de quién es este producto?"*. Además está vacía hasta que alguien
carga un remito.

Hay un segundo problema, hermano del primero, que quedó anotado en el chunk anterior:
**`settings.descuento_proveedor_porcentaje` (42%) es global pero es el descuento de Quimex.** Cuando
KUM entre en serio, aplicarle a sus productos el descuento comercial de Quimex les rompe el costo.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Que cada producto sepa **de qué proveedor es**, y que los 1104 existentes queden etiquetados sin
   trabajo manual.
2. **Filtro por proveedor** en `/productos`, que se combine con los que ya hay.
3. Poder **mover los precios de todos los productos de un proveedor** de una sola vez.
4. Que el **descuento comercial sea por proveedor**, no uno global para todos.

### No-objetivos (YAGNI)

- **Varios proveedores por producto.** El modelo mental del negocio es "este producto es de KUM".
  Un producto que se le compra a dos proveedores es un caso que hoy no tienen y que complicaría
  filtro, costo y descuento. Si aparece, `producto_codigos_proveedor` ya soporta las equivalencias.
- **Historial de cambios de precio.** No existe hoy y no se pidió. Se compensa con la vista previa
  del §6.3, que muestra qué va a pasar ANTES de aplicarlo.
- **Listas de precios por proveedor como entidad.** Importar sigue siendo "subo un archivo y
  actualizo el catálogo".
- **Tocar `producto_codigos_proveedor`.** Sigue siendo lo que es.

---

## 3. Un proveedor por producto

```sql
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS proveedor_id uuid REFERENCES public.proveedores(id);
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON public.productos (proveedor_id);
```

Nullable: un producto puede no tener proveedor cargado (los que crea el alta rápida de Ingresos, o
los que carguen a mano). `ON DELETE` se deja en el default (`NO ACTION`): borrar un proveedor que
tiene productos tiene que fallar, no dejar el catálogo huérfano en silencio.

### 3.1 Cómo se etiquetan los 1104 que ya están

Con un selector **"Proveedor de esta lista"** en la pantalla de importar: se elige una vez y todas
las filas de ese archivo quedan con ese proveedor.

Esto encaja solo con el chunk anterior: el §12 de aquella spec ya obliga a **reimportar la lista de
Quimex una vez**. Eligiendo "Quimex" en ese selector, los 1104 productos quedan etiquetados en la
misma pasada, sin trabajo extra.

Es opcional. Si no se elige proveedor, la clave se omite del payload y **no se pisa** el que el
producto ya tenía — la misma regla que el chunk anterior tuvo que aprender a los golpes: *la
importación sólo escribe lo que la planilla (o la pantalla) realmente trae*.

Además, un **"Asignar proveedor"** masivo desde `/productos`, para la selección actual. Es la salida
para los productos que no vienen de ninguna lista.

---

## 4. El descuento pasa a ser del proveedor

```sql
ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS descuento_porcentaje numeric(6,2)
    CHECK (descuento_porcentaje IS NULL OR (descuento_porcentaje >= 0 AND descuento_porcentaje < 100));
```

`NULL` = "usá el global". El descuento efectivo de un producto es:

```
proveedores.descuento_porcentaje  ??  settings.descuento_proveedor_porcentaje  ??  42
```

Es la misma escalera que ya usa el markup (`productos.markup_porcentaje ?? settings ?? 30`), así que
no hay un concepto nuevo que aprender. El campo va en el formulario de proveedores, al lado de
"cuenta corriente".

El `CHECK` corta en 100 porque un descuento del 100% o más da costo cero o negativo — el chunk
anterior encontró que un descuento de 142 escribía precios negativos y dejaba el catálogo
invendible.

**Qué NO cambia:** `settings.descuento_proveedor_porcentaje` se queda donde está y sigue siendo el
default. No hay migración de datos: Quimex arranca en `NULL` y hereda el 42% global, o sea que se
comporta exactamente como hoy hasta que alguien le ponga un número propio.

---

## 5. El filtro

Un `Select` de proveedores al lado del de categorías: *"Todos los proveedores"* + la lista + una
opción **"Sin proveedor"** (para encontrar los que quedaron sin etiquetar, que si no son invisibles).

Se combina con la búsqueda de texto y la categoría, como ya se combinan entre sí. El contador del
encabezado (`{filtered.length} de {productos.length}`) ya refleja el filtro, no hay que tocarlo.

`/productos` ya trae los productos paginados con `traerTodo` y filtra en memoria, así que el filtro
nuevo es una condición más en el `useMemo`. No hace falta ir a la base.

La tabla suma una columna **Proveedor**. Para que no crezca a 13 columnas —que ya no entraban— se
va **Marca**: es un dato que casi ningún producto tiene cargado (la lista de Quimex no lo trae) y
sigue estando en la búsqueda, en el diálogo y en las exportaciones.

---

## 6. Mover los precios de a muchos

El cliente dijo dos cosas distintas en la misma frase — *"le tienen que aumentar un 20%"* y
*"aplicarle el markup que sea"*. **Son dos operaciones diferentes y las dos hacen falta**, así que
el diálogo pasa a tener las dos, elegibles con un radio:

### 6.1 Cambiar el markup a X%

Lo que ya existe. Guarda `markup_porcentaje = X` en cada producto y recalcula el precio de venta con
la cadena de `precios.ts`. **Es idempotente**: aplicarlo dos veces da el mismo resultado.

Sirve para: *"a los productos de KUM les quiero ganar 40% en vez de 30%"*.

### 6.2 Aumentar los precios X%

Nueva. Multiplica por `(1 + X/100)` los precios que **vienen del proveedor**, y deja que el precio
de venta se recalcule solo:

```
precio_lista            × (1 + X/100)
precio_fabrica          × (1 + X/100)
precio_sugerido_publico × (1 + X/100)   (si tiene)
markup                  sin tocar
→ el precio de venta sale de la cadena de siempre
```

Sirve para: *"KUM mandó lista nueva, todo aumentó 20%"* — que es el caso que el cliente describió, y
que hoy sólo se resuelve pidiéndole el Excel a KUM.

**NO es idempotente**: aplicarlo dos veces da +44%, no +20%. Por eso el §6.3.

### 6.3 Antes de aplicar, se ve qué va a pasar

El diálogo muestra, con los tres primeros productos de la selección, el antes y el después:

```
ACRIL MEX NEGRO x4     lista  30.774,40 → 36.929,28     venta  44.681,78 → 53.618,14
ACRIL MEX NEGRO x20   lista 141.562,70 → 169.875,24    venta 205.536,63 → 246.643,96
...y 1101 productos más
```

No hay historial de precios, así que **esta pantalla es la única oportunidad de darse cuenta antes**
de multiplicar el catálogo entero. Un aumento aplicado dos veces por accidente no se puede deshacer
con un botón.

Además, el botón de confirmar dice qué operación es y sobre cuántos productos: *"Aumentar 20% a 1104
productos"* / *"Poner markup 40% en 1104 productos"*. No *"Aplicar"*.

### 6.4 Lo que ya está resuelto y no hay que rehacer

`aplicarMarkup` ya lee en tandas de 500 y aborta si no puede leer todos los seleccionados (hallazgo
§14.6 del chunk anterior). La operación nueva usa el mismo camino. Lo que **sí** hay que mirar acá:
las escrituras siguen siendo un `UPDATE` por producto, y este chunk es justamente el que hace fácil
seleccionar 1104 de una. Se batchean las escrituras en tandas, con contador de progreso, como se
hizo en la importación.

---

## 7. Qué NO se toca

- **`producto_codigos_proveedor`**: sigue siendo la tabla de equivalencias de códigos para matchear
  remitos. Nada de este chunk la lee ni la escribe.
- **El stock.** Nada de acá lo mueve.
- **Las ventas ya emitidas** y la facturación: guardan su propio precio.
- **La cadena de precios** de `precios.ts`: se usa tal cual, sólo cambia de dónde sale el descuento.

---

## 8. Verificación

**Unit (`src/lib/precios.test.ts`):**
- El descuento efectivo: propio del proveedor > global de settings > 42.
- Un descuento de proveedor de 0 es válido (comprar a precio de lista) y no cae al global.
- `aumentarPrecios(producto, 20)` multiplica lista, costo y sugerido, y NO toca el markup.
- Aumentar 20% dos veces da +44%: el test documenta que no es idempotente.
- Aumentar 0% no cambia nada.

**Unit (`src/lib/importar-productos.test.ts`):**
- Importar con proveedor elegido lo escribe; sin elegirlo, la clave se omite y no pisa el que había.

**Integración / e2e (extendiendo `scripts/test-precios-sugerido-e2e.mjs`):**
- Importar con "Proveedor de esta lista" = Quimex etiqueta todas las filas.
- Filtrar por proveedor y por "Sin proveedor" devuelve los conjuntos correctos.
- Aumentar 20% sobre una selección mueve lista, costo, sugerido y venta, y deja el markup igual.
- Cambiar el markup sobre una selección con productos de los dos tipos (con y sin sugerido)
  recalcula cada uno por su rama.
- Con más de 1000 productos seleccionados no se saltea ninguno.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 9. Orden de implementación

1. Migración: `productos.proveedor_id` + índice, `proveedores.descuento_porcentaje` + CHECK.
   Regenerar `types.ts`.
2. `precios.ts`: `descuentoEfectivo(proveedor, settings)` y `aumentarPrecios(producto, pct)` + tests.
3. Proveedores: campo de descuento en el formulario y en la tabla.
4. Importar: selector "Proveedor de esta lista", con la regla de no pisar si no se elige.
5. `/productos`: filtro por proveedor, columna Proveedor (sale Marca), "Asignar proveedor" masivo.
6. El diálogo de precios masivos: las dos operaciones, la vista previa del antes/después, y el
   batcheo de las escrituras con progreso.
7. e2e.

Del 1 al 5 nada cambia de comportamiento: mientras ningún producto tenga proveedor y ningún
proveedor tenga descuento propio, todo sigue igual que hoy.
