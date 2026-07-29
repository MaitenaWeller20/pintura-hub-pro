# Compras registra plata, Ingresos registra mercadería — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec escrito. Pendiente: review con Codex, implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §4, §5 y §6.

---

## 1. El problema

Tres pedidos del cliente que son el mismo problema visto de tres lados:

> *"En la pestañita compras deberíamos dejar solamente cuánto compraron en plata, no agregar los
> productos ni nada de eso."*
>
> *"De última sí dejar el remito cargado, pero que no tome nada del stock ni de productos, solamente
> dejarlo registrado."*
>
> *"Casi siempre son cuenta corriente y lo pagan después. Compraron a Quimex 4 millones y no se lo
> pagan en ese momento. Tiene que haber en algún lugar registrar cuánto le van pagando. Compraron 4
> millones, le pagaron 2. Hay que dejar registrado eso y también poder descargar un comprobante."*
>
> *"El ingreso de mercadería lo vamos a hacer a mano. Es un bardo lo de cargarlo con una foto, con
> un PDF."*

Hoy el sistema tiene **dos caminos que mueven stock** y los dos piden cargar productos uno por uno:

| | Qué hace hoy | Qué quiere el negocio |
|---|---|---|
| **Compras** | comprobante + ítems → **suma stock** (`crear_compra`) | sólo el comprobante y **cuánta plata** |
| **Ingresos de mercadería** | subir foto/PDF → extracción con IA → confirmar → suma stock | buscar el producto **a mano** y poner la cantidad |

Y el pago al proveedor existe (`registrar_pago_proveedor`) pero está escondido adentro de Cuentas
Corrientes, sin comprobante para imprimir.

La separación que quiere el negocio es limpia y es la correcta: **Compras es el libro de la plata,
Ingresos es el libro de la mercadería.** Cada uno hace una cosa.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Que cargar una compra sea **escribir cuánto se gastó**, sin tocar productos ni stock.
2. Que el remito/factura del proveedor **quede registrado** igual, como papel.
3. Que **pagarle al proveedor** tenga lugar propio y **comprobante descargable**.
4. Que ingresar mercadería sea **buscar el producto y poner la cantidad**.

### No-objetivos (YAGNI)

- **Borrar las compras viejas ni sus ítems.** Las que ya se cargaron con productos siguen
  guardadas y se siguen viendo. Sólo cambia lo que se carga de acá en adelante (§3.3).
- **Imputar los pagos contra comprobantes puntuales (FIFO).** El cliente pidió saldo: *"compraron 4
  millones, le pagaron 2"*. El libro de cuenta corriente del proveedor ya lleva ese saldo. Imputar
  pago-contra-factura es otra feature y nadie la pidió.
- **Conservar la extracción con IA como opción.** El cliente fue explícito. El código
  (`ingresos-ia.ts`, `extraerYMatchearRemito`) se saca de la pantalla; ver §5.3 sobre qué pasa con
  la RPC y la tabla de equivalencias.
- **Órdenes de compra / pedidos al proveedor.** No existe y no se pidió.

---

## 3. Compras: sólo la plata

### 3.1 La pantalla

`/compras/nueva` pierde el bloque **Productos** entero. Queda:

```
Sucursal · Proveedor · Tipo y N° de comprobante · Fecha · Vencimiento · Condición
Subtotal s/IVA · IVA · Percepciones  →  TOTAL
Formas de pago
```

Los tres montos **se escriben**. Hoy salen de sumar los ítems; sin ítems, los pone la persona
mirando la factura, que es lo que hace igual con la calculadora.

El IVA queda como un campo suelto y no derivado: en una factura real conviven alícuotas distintas y
percepciones, y obligar a que el sistema lo recomponga desde un porcentaje único sería inventar un
número que no está en el papel.

### 3.2 La RPC

`crear_compra` cambia de forma. Firma nueva (la vieja se reemplaza, no se acumula: son 11
parámetros y dejar dos versiones es garantía de llamar a la equivocada):

```sql
crear_compra(
  p_proveedor_id, p_sucursal_id, p_tipo_comprobante, p_numero,
  p_fecha_comprobante, p_fecha_vencimiento,
  p_subtotal_sin_iva numeric,      -- ← escrito, ya no derivado de ítems
  p_iva_total        numeric,      -- ←
  p_percepciones     numeric,
  p_pagos jsonb, p_condicion, p_observaciones
) RETURNS TABLE (compra_id uuid)
```

**Se va el parámetro `p_items`, el `INSERT INTO compra_items` y el `INSERT INTO stock_movimientos`.**
El resto —la deuda de cuenta corriente, la caja, la validación de comprobante duplicado, la
condición CONTADO/CTA_CTE— queda igual.

`total = subtotal + iva + percepciones`, redondeado, calculado en la RPC. No se recibe de afuera:
un total que no cierra con sus partes es un dato corrupto que después nadie puede explicar.

### 3.3 Qué pasa con las compras que ya existen

`compra_items` **no se borra ni se toca**. Las compras cargadas con productos siguen mostrando su
detalle. Lo único que cambia es que las nuevas no van a tener ítems.

`anular_compra` hoy revierte stock. Pasa a revertir stock **sólo si la compra tiene ítems**: una
compra nueva no movió stock, así que anularla no tiene nada que devolver. Sin esa condición,
anular una compra nueva restaría stock que esa compra nunca sumó.

### 3.4 Un aviso en la pantalla

Arriba del formulario, una línea: *"Esto registra la plata que se le debe al proveedor. **No suma
stock**: la mercadería se carga en Ingresos de mercadería."* Es el mismo tipo de cartel que se puso
en la importación después del episodio del envase, y por la misma razón: la pantalla tiene que decir
qué NO hace.

---

## 4. Pagos a proveedores

### 4.1 Lugar propio

Ruta nueva `/pagos-proveedores`, en el menú **Compras** (debajo de Proveedores). No se toca
`/pagos`, que es la plata que entra de los clientes — nombres parecidos, cosas opuestas, y por eso
el ítem del menú dice **"Pagos a proveedores"** completo.

La pantalla lista los pagos con proveedor, fecha, monto, forma de pago y estado, con los filtros de
período que ya usan las demás. Arriba, el saldo por proveedor: *"Quimex: compraste $4.000.000,
pagaste $2.000.000, debés $2.000.000"* — que es literalmente el ejemplo que dio el cliente.

Botón **Pagar**: proveedor, monto, forma de pago. Llama a `registrar_pago_proveedor`, que ya existe
y ya hace lo correcto (exige caja abierta, valida sucursal, escribe el movimiento de cuenta
corriente y la salida de caja). **No se toca esa RPC.**

Cuentas Corrientes conserva su diálogo de pago: es el mismo camino desde otra puerta.

### 4.2 El comprobante

Botón de descarga por pago, y también al terminar de pagar. PDF con jsPDF, que ya está en el
proyecto y ya se usa para el listado de productos y la planilla de conteo.

Contenido: encabezado del negocio y sucursal, número de pago, fecha, proveedor con CUIT, monto en
números y en letras, forma de pago, y el saldo del proveedor después del pago. Pie con quién lo
registró.

**No es un comprobante fiscal** y lo dice: *"Comprobante interno de pago. No válido como factura."*
Es un recibo para el proveedor y para el archivo del negocio, y confundirlo con un comprobante AFIP
sería un problema de verdad.

---

## 5. Ingresos de mercadería a mano

### 5.1 La pantalla

`/ingresos-mercaderia/nuevo` pierde el bloque de subir archivo y la extracción. Queda:

```
Sucursal · Proveedor · Tipo y N° de remito · Fecha
[ Buscar producto por código o nombre ]  → se agrega a la lista
Producto · Cantidad que entró        (una fila por producto, editable, borrable)
[ Confirmar ingreso ]  → suma el stock
```

El buscador va contra el catálogo —*"tiene que buscarlo al producto en productos, que sería la lista
de precios que cargamos"*, textual del cliente— con la RPC `buscar_productos_similares`, que ya
existe y ya se usa para el matching manual.

### 5.2 Lo que NO hay que construir

El motor ya está y no se toca:

| RPC | Qué hace |
|---|---|
| `crear_borrador_ingreso` | abre el borrador |
| `actualizar_items_borrador` | guarda las filas mientras se cargan |
| `confirmar_ingreso_mercaderia` | valida y **suma el stock** con kardex, en una transacción |
| `anular_ingreso_mercaderia` | lo revierte |
| `buscar_productos_similares` | el buscador |
| `crear_producto_desde_ingreso` | alta rápida de un producto que no está en el catálogo |

O sea que este chunk es **casi todo pantalla**. El riesgo está en no romper el circuito que ya
funciona, no en inventar uno nuevo.

### 5.3 Qué pasa con la extracción por IA

Se saca **de la pantalla**, no de la base:

- `guardar_extraccion_ingreso` y la server fn `extraerYMatchearRemito` quedan sin llamador. Se
  borra la server fn y el uso del SDK; la RPC queda huérfana y se marca con un `COMMENT` que diga
  desde cuándo y por qué, para que nadie la revuelva sin contexto.
- `producto_codigos_proveedor` **se sigue usando y se sigue alimentando**: cuando alguien elige a
  mano qué producto es el código del remito, esa equivalencia se guarda igual. Es lo que hace que el
  segundo remito del mismo proveedor venga más resuelto, y no depende de la IA.
- Los ingresos ya cargados y sus estados (`BORRADOR`, `CONFIRMADO`, `ANULADO`) no se tocan.

Un borrador viejo que quedó a medio extraer se puede seguir editando a mano: los ítems son los
mismos, sólo cambia de dónde salieron.

---

## 6. Qué NO se toca

- **La caja.** `registrar_pago_proveedor` sigue exigiendo caja abierta y sigue registrando la
  salida.
- **La cuenta corriente del proveedor.** Mismo libro, mismos movimientos.
- **Las ventas, la facturación y los precios.** Nada de este chunk los mira.
- **`compra_items`** como tabla y como historia.

---

## 7. Verificación

**SQL (`scripts/test-compras-plata.sh`):**
- `crear_compra` con montos escritos: guarda el comprobante, **no** escribe `compra_items`, **no**
  escribe `stock_movimientos`, y el stock del proveedor queda igual que antes.
- `total = subtotal + iva + percepciones`, y un total incoherente no se puede inyectar (no se
  recibe).
- CTA_CTE genera la deuda; CONTADO exige caja abierta y la descuenta. Igual que hoy.
- Comprobante duplicado sigue rechazado.
- `anular_compra` sobre una compra NUEVA (sin ítems) no toca stock; sobre una VIEJA (con ítems) sí
  lo revierte.
- `registrar_pago_proveedor` sin caja abierta falla; con caja abierta baja el saldo.
- Un empleado no puede anular.

**e2e con navegador** (extendiendo `test-precios-sugerido-e2e.mjs` o uno propio):
- Cargar una compra de $100.000 no cambia el stock de ningún producto.
- Cargar un ingreso de mercadería a mano de 5 unidades sube el stock en 5 y deja kardex.
- Buscar un producto por código y por nombre en el ingreso lo encuentra.
- Descargar el comprobante de un pago devuelve un PDF no vacío.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 8. Orden de implementación

Los dos cambios **salen juntos**, y el orden importa: si Compras deja de sumar stock antes de que
Ingresos sea usable a mano, el negocio se queda sin ninguna forma de cargar mercadería.

1. Ingresos a mano (§5): la pantalla, con las RPC que ya existen. **Primero**, porque es el camino
   que va a quedar para cargar stock.
2. Migración: `crear_compra` nueva, `anular_compra` condicionada a que haya ítems.
3. `/compras/nueva`: se va el bloque de productos, entran los montos, entra el aviso.
4. `/pagos-proveedores`: pantalla, saldo por proveedor, diálogo de pago, PDF.
5. Se saca la extracción con IA de la pantalla y se borra la server fn.
6. Tests SQL + e2e.

Entre el 1 y el 2 el sistema queda con **dos** caminos que suman stock, que es el estado de hoy: no
hay ventana en la que no se pueda cargar.
