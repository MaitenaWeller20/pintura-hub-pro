# Correcciones del cliente (28/07/2026) — backlog

**Fecha:** 2026-07-29
**Estado:** Backlog. Cada punto se implementa con su propia spec.
**Origen:** Visita de Leo al negocio con la empleada. Audios + fotos de pantalla del 28/07/2026.

Este documento **no es un diseño**: es la lista completa de lo que pidió el cliente, en criollo,
para que no se pierda nada del audio. Cada bloque numerado se convierte después en su propia spec.

---

## Contexto

Quien va a usar el sistema es el negocio de pinturería (CasaForma). Compran casi todo a **Quimex**
(Quimexur), que les manda una **lista de precios en Excel** y les hace un **descuento comercial del
42%**. También le compran a otros proveedores, **KUM** entre ellos.

Mientras tanto: el negocio va a ir cargando clientes y proveedores a mano, y Leo carga el stock
real un sábado (ver `2026-07-24-conteo-fisico-design.md`).

---

## 1. Precios — está mal calculado ⚠️

**Lo que dijo:** *"Precio sugerido al público + un 30%"*, *"Precio de lista es el precio de
Quimex"*, *"Precio (costo) sería el precio de Quimex − el descuento que les hace Quimex"*, *"Está
calculando todo mal"*.

Comprobado con `4000-00400` (membrana poliuretánica x4):

| | |
|---|---|
| Precio de lista Quimex (s/IVA) | $30.774,40 |
| − 42% = costo s/IVA | $17.849,15 |
| + 21% IVA = lo que le pagan a Quimex | $21.597,47 |
| Sugerido al público C/IVA (lo trae la lista) | $34.370,60 |
| **+ 30% markup = precio de venta** | **$44.681,78** |
| Lo que el sistema muestra hoy | $28.076,76 |

El sistema calcula `costo × (1 + markup) × (1 + IVA)` y **nunca usa la columna "Sugerido al
público"** — el campo ni siquiera existe en la importación.

**Duda del cliente resuelta:** *"no sabemos si el IVA ya está aplicado en el precio sugerido"*. La
columna del Excel se llama literalmente **"Sugerido al público C/IVA"**. Ya viene con IVA.

→ Spec: `2026-07-29-precios-sugerido-publico-design.md`

## 2. Columnas al importar la lista

**Lo que dijo:** *"tenemos que ver en las columnitas: el precio de la lista de Quimex, el precio de
Quimex con el descuento que les hacen a mi mamá, el precio que le hacen a mi mamá más IVA, el
precio sugerido al público y el sugerido al público más el markup"*. Y sobre la pantalla actual:
*"Esta parte está media confusa"*.

Cinco columnas. Hoy faltan tres (costo c/IVA, sugerido, venta) y la pantalla dejó mapear la misma
columna del Excel en dos campos a la vez, y un precio dentro de "IVA %".

→ Misma spec que el punto 1.

## 3. Filtro por proveedor + markup masivo

**Lo que dijo:** *"KUM cambió la lista de precios, ahora le tienen que aumentar un 20%, a veces un
10%, entonces que se pueda seleccionar todos los productos de este proveedor para aplicarle el
markup que sea"*.

Los productos **no tienen proveedor** en la base (sólo marca y categoría). Hay que agregarlo, poner
el filtro en `/productos` y que el "Aplicar markup" masivo funcione sobre la selección.

Nota de diseño para esa spec: hoy `settings.descuento_proveedor_porcentaje` (42%) es **global**,
pero es un descuento **de Quimex**. Cuando entre KUM en serio, el descuento pasa a ser por
proveedor. Y `aplicarMarkup` hace un UPDATE por producto en un loop — con cientos de productos
seleccionados eso hay que medirlo o batchearlo.

## 4. Compras: solamente la plata

**Lo que dijo:** *"en la pestañita compras deberíamos dejar solamente cuánto compraron en plata, no
agregar los productos ni nada de eso"*, *"de última sí dejar el remito cargado, pero que no tome
nada del stock ni de productos, solamente dejarlo registrado"*.

Sacar los ítems de la carga de compra. Queda sucursal, proveedor, tipo y nº de comprobante, fecha,
condición y **el monto**. No toca stock.

## 5. Pagos a Quimex + comprobante

**Lo que dijo:** *"casi siempre son cuenta corriente y lo pagan después. Compraron a Quimex 4
millones y no se lo pagan en ese momento. Tiene que haber en algún lugar registrar cuánto le van
pagando. Compraron 4 millones, le pagaron 2. Hay que dejar registrado que le pagaron 2 millones y
también poder descargar un comprobante de eso"*.

La RPC `registrar_pago_proveedor` ya existe, pero está escondida dentro de Cuentas Corrientes.
Falta: lugar propio y **comprobante descargable**.

## 6. Ingreso de mercadería a mano

**Lo que dijo:** *"lo vamos a hacer a mano, van a cargar el ingreso de mercadería a mano"*, *"es un
bardo lo de cargarlo con una foto, con un PDF"*, *"ponés nuevo ingreso: sucursal sí, proveedor sí, y
acá en vez de esto ponemos código, nombre del producto, y tiene que buscarlo al producto en
productos — que sería la lista de precios que cargamos — y ponen cuánto ingresó ese producto"*.

Sacar la extracción con IA (foto/PDF). Queda: sucursal + proveedor + buscador contra el catálogo +
cantidad. Esto **sí** suma stock.

## 7. Presupuestos

**Lo que dijo:** *"tienen que poder hacer presupuestos que lógicamente esos productos no se van del
stock y ese monto tampoco se cobra, porque es un presupuesto para mandarle a cualquier cliente.
Pero después, si ese cliente viene, tienen que poder asociar el presupuesto y se les cargan todos
los productos que habían puesto con el precio que les habían hecho"*. Se lo busca *"por la fecha o
por el número"*. Hay un video del flujo en el sistema viejo (3C Informática → Ventas →
Presupuestos).

No existe nada de esto todavía.

## 8. Seguimiento de un producto

**Lo que dijo:** *"me dice que es muy importante: ¿cuándo ingresó un pincel? ¿cuántas cantidades
ingresaron? y en el tiempo, ¿cómo se fue vendiendo? ¿se ingresaron más unidades? si la gente se lo
llevó como cuenta corriente. Quieren ver el avance de los productos y ellos seleccionar qué
producto quieren ver"*.

Es la pantalla "Seguimiento de Artículos" del sistema viejo: fecha, artículo, persona, sucursal,
comprobante, origen. La data ya está en `stock_movimientos`; falta la pantalla.

---

## Orden

1. **Precios** (§1 + §2) — es un bug, está en producción, y todo lo demás cuelga de que el precio
   esté bien.
2. **Proveedor en productos + filtro + markup masivo** (§3) — la columna `proveedor_id` la
   necesitan también §4, §5 y §6.
3. **Compras solo plata + pagos a proveedor** (§4 + §5) — se tocan la misma pantalla y el mismo
   libro de cuenta corriente.
4. **Ingreso manual** (§6).
5. **Presupuestos** (§7) — el más grande; entidad nueva + conversión a venta.
6. **Seguimiento de producto** (§8).

## Migración de datos pendiente

Después de §1: hay que **volver a importar la lista de Quimex una vez**. Los 1104 productos que ya
están en producción no se pueden arreglar solos, porque el "Sugerido al público" nunca se guardó —
no existe la columna. No se pierde nada; es un re-import.
