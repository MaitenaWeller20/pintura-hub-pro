# Compras registra plata, Ingresos registra mercadería — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec revisado con Codex (§9, 12 hallazgos incorporados). Pendiente: implementación.
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

`crear_compra` cambia de forma. Firma nueva:

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

Se va `p_items`, el `INSERT INTO compra_items` y el `INSERT INTO stock_movimientos`. El resto —la
deuda de cuenta corriente, la caja, el comprobante duplicado, CONTADO/CTA_CTE— queda igual.

`total = subtotal + iva + percepciones`, calculado en la RPC. No se recibe de afuera: un total que
no cierra con sus partes es un dato corrupto que después nadie puede explicar.

#### `CREATE OR REPLACE` no alcanza: hay que DROPear la firma vieja

Postgres identifica una función por **nombre + tipos de parámetros**. La firma nueva tiene 12
parámetros y la vieja 11, así que `CREATE OR REPLACE` **crea una segunda función** y deja la vieja
viva, con su `GRANT EXECUTE TO authenticated` intacto
(`20260715120000_pagos_anulaciones_proveedor.sql:203`). Cualquiera podría seguir llamándola y
seguiría insertando `compra_items` y `stock_movimientos`: un camino paralelo que suma stock, que es
exactamente lo que este chunk viene a cerrar.

Pero dropearla a secas rompe `/compras/nueva`, que hoy manda `p_items`
(`compras.nueva.tsx:180`), durante la ventana entre el `db push` y el deploy del frontend.

La salida que cierra las dos puntas: **la firma vieja se conserva pero se le vacía el cuerpo**, y
pasa a ser un puente que deriva los totales de los ítems que reciba y llama a la nueva —**sin tocar
stock**.

```
crear_compra(... p_items ...)   →  suma los ítems y llama a la firma nueva. NO mueve stock.
crear_compra(... montos ...)    →  la de verdad.
```

Así, en cualquier orden de deploy: el frontend viejo sigue andando y ya no suma stock, y el nuevo
usa la firma nueva. El puente lleva un `COMMENT` que dice que se puede dropear una vez que el
frontend nuevo esté arriba, y se dropea en una migración posterior — no en ésta.

#### Los montos escritos hay que validarlos

Hoy `compras` **no tiene ningún CHECK** sobre sus montos
(`20260715100000_compras_proveedores_schema.sql:94`); no hacía falta porque la RPC los derivaba de
los ítems, validando costo, cantidad e IVA de cada uno. Con montos escritos a mano eso desaparece, y
esos números alimentan la deuda del proveedor (`proveedor_cc_movimientos`) y la salida de caja: un
total absurdo o negativo corrompe el saldo y el arqueo.

En la RPC:

```
subtotal >= 0,  iva >= 0,  percepciones >= 0,  total > 0
total <= 999.999.999      (ninguna compra de una pinturería llega a mil millones)
```

Y en la tabla, para que no dependa sólo de la RPC:

```sql
ALTER TABLE public.compras
  ADD CONSTRAINT compras_montos_no_negativos
  CHECK (subtotal_sin_iva >= 0 AND iva_total >= 0 AND percepciones >= 0 AND total >= 0);
```

### 3.3 `anular_compra` NO se toca

La versión vigente (`20260720110000_rediseno_caja_apertura_automatica.sql:336` — no la de la
migración original) ya hace lo correcto sola: recorre `compra_items` para revertir stock, y una
compra nueva no tiene ítems, así que **el loop no ejecuta nada**. La reversión de la deuda y la
compensación de caja están *después* del loop, así que corren igual.

Tocarla sería puro riesgo: esa versión tiene el lock de sucursal contra deadlocks y la compensación
de caja de las anulaciones al contado, y reimplementarla mirando la migración vieja regresaría las
dos cosas.

`compra_items` tampoco se borra: las compras cargadas con productos siguen mostrando su detalle.

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
y ya hace lo correcto: valida sucursal, escribe el movimiento de cuenta corriente y la salida de
caja. **La caja se AUTO-ABRE** desde el rediseño de `20260720110000` (`caja_sesion_actual`), así que
no hay que abrirla antes ni hay error por caja cerrada.

Cuentas Corrientes conserva su diálogo de pago: es el mismo camino desde otra puerta.

### 4.2 El comprobante

Un recibo tiene que decir siempre lo mismo. Para eso faltan dos datos que `proveedor_pagos` hoy no
guarda (`20260715100000_compras_proveedores_schema.sql:148`):

```sql
ALTER TABLE public.proveedor_pagos
  ADD COLUMN IF NOT EXISTS numero text,              -- OHI-PAGO-0001
  ADD COLUMN IF NOT EXISTS saldo_posterior numeric(14,2);
```

- **`numero`**: un recibo sin número no se puede referenciar. Se usa
  `siguiente_numero_comprobante`, que ya es atómica, con el tipo `PAGO_PROVEEDOR`.
- **`saldo_posterior`**: el saldo del proveedor **en el momento del pago**, congelado. Si el PDF lo
  calculara del saldo actual, reimprimir un recibo de hace un mes mostraría un número distinto —
  un comprobante que cambia solo no sirve como comprobante.

Los dos los escribe `registrar_pago_proveedor`, que es lo único que se le agrega.

Contenido del PDF: datos del emisor (`fiscal_config_publica`, que ya existe y ya lo usa el PDF de
ventas), sucursal, número y fecha, proveedor con CUIT, monto en números y en letras, forma de pago,
saldo posterior, y quién lo registró.

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
Producto · Cantidad que entró · Código del proveedor (opcional)
[ Confirmar ingreso ]  → suma el stock
```

**El "código del proveedor" no es decorativo.** `confirmar_ingreso_mercaderia` alimenta
`producto_codigos_proveedor` con ese campo
(`20260724140000_ingreso_rechaza_archivado.sql:115`): es lo que hace que el segundo remito del mismo
proveedor venga más resuelto. Si la pantalla manual sólo capturara producto y cantidad, la tabla que
aprende **dejaría de aprender**. Va precargado con el código interno del producto y se puede
cambiar por el que figura en el remito del proveedor.

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
mismos, sólo cambia de dónde salieron. **Con una excepción:** si tiene `bloqueo_confirmacion`
cargado (una inconsistencia que detectó la extracción), `confirmar_ingreso_mercaderia` lo rechaza
siempre y `actualizar_items_borrador` no limpia ese campo
(`20260724140000_ingreso_rechaza_archivado.sql:56`). Esos borradores hay que **anularlos y rehacerlos
a mano**; la pantalla lo dice en vez de dejar que la persona choque contra un error que no puede
resolver.

**El rate limit de `crear_borrador_ingreso`** (`20260724110000_ingresos_mercaderia_rpcs.sql:34`)
estaba pensado para frenar el gasto de la IA. Sin IA no tiene sentido y puede trabar una carga
manual de varios remitos seguidos: se sube el tope, no se saca (sigue siendo una defensa contra un
bucle accidental).

---

## 6. Qué NO se toca

- **La caja.** `registrar_pago_proveedor` sigue registrando la salida, con la caja auto-abriéndose
  como desde `20260720110000`.
- **Los permisos.** Hoy cualquier usuario autenticado puede cargar una compra y pagarle a un
  proveedor de su sucursal; anular es sólo admin. Se **mantiene** tal cual: la empleada es
  justamente quien carga y quien paga, y restringirlo la dejaría sin poder trabajar. Se anota acá
  para que sea una decisión y no un olvido.
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
- `anular_compra` sobre una compra NUEVA (sin ítems) no toca stock pero **sí** revierte la deuda y
  compensa la caja; sobre una VIEJA (con ítems) además revierte el stock. No se modifica la función:
  el test verifica que sigue haciendo lo correcto sin tocarla.
- Montos inválidos rechazados: negativos, total en cero, total absurdo.
- La firma VIEJA de `crear_compra` (con `p_items`) sigue andando y **ya no mueve stock**.
- `registrar_pago_proveedor` baja el saldo y deja la salida de caja (la caja se auto-abre; NO hay
  caso "falla por caja cerrada").
- El pago guarda `numero` y `saldo_posterior`, y ese saldo **no cambia** después de un pago
  posterior: reimprimir un recibo viejo da el mismo papel.
- Un empleado no puede anular.

**e2e con navegador** (extendiendo `test-precios-sugerido-e2e.mjs` o uno propio):
- Cargar una compra de $100.000 no cambia el stock de ningún producto.
- Cargar un ingreso de mercadería a mano de 5 unidades sube el stock en 5 y deja kardex.
- Ese ingreso manual **guarda la equivalencia** en `producto_codigos_proveedor`, y el remito
  siguiente del mismo proveedor la encuentra.
- Buscar un producto por código y por nombre en el ingreso lo encuentra.
- Descargar el comprobante de un pago devuelve un PDF no vacío.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 8. Orden de implementación

Los dos cambios salen juntos, y el orden importa: si Compras deja de sumar stock antes de que
Ingresos sea usable a mano, el negocio se queda sin ninguna forma de cargar mercadería.

1. **Ingresos a mano** (§5): la pantalla, con las RPC que ya existen. Primero, porque es el camino
   que va a quedar para cargar stock. Deploy y verificación en producción **antes de seguir**.
2. Migración de compras: firma nueva, puente en la firma vieja, CHECK de montos, `numero` y
   `saldo_posterior` en `proveedor_pagos`, tipos de comprobante nuevos. Regenerar `types.ts`.
3. `/compras/nueva`: se va el bloque de productos, entran los montos, entra el aviso. Y los textos
   que hoy dicen "suma stock" (`compras.nueva.tsx:222`) y "revierte stock"
   (`compras.index.tsx:91`), que para una compra sin ítems son mentira.
4. `/pagos-proveedores`: pantalla, saldo por proveedor, diálogo de pago, PDF.
5. Se saca la extracción con IA de la pantalla y se borra la server fn.
6. Tests SQL + e2e.

**La ventana de deploy queda cerrada por el puente de §3.2**: entre el `db push` y el deploy del
frontend, la pantalla vieja sigue funcionando y ya no suma stock. Sin ese puente habría que elegir
entre romper la pantalla o dejar vivo el camino que suma stock.

---

## 9. Hallazgos del review del spec con Codex

Doce hallazgos. Codex abrió con *"no implementaría este spec así"*, y tenía razón en los cuatro
primeros.

1. **`CREATE OR REPLACE` no reemplaza una función si cambia la firma.** La vieja quedaba viva con
   permiso de ejecución y seguía sumando stock: un camino paralelo que este chunk viene justo a
   cerrar. → §3.2, con el puente que además cierra la ventana de deploy.
2. **La ventana entre el `db push` y el deploy del frontend.** Dropear la firma vieja rompe
   `/compras/nueva`; no dropearla deja el bypass. → el puente resuelve las dos.
3. **`anular_compra` apuntaba a la migración equivocada.** La versión vigente está en
   `20260720110000`, con lock de sucursal contra deadlocks y compensación de caja; implementar
   copiando la vieja habría regresado las dos. Y encima **no hay que tocarla**: el loop sobre
   `compra_items` ya no hace nada cuando no hay ítems. → §3.3, un cambio menos.
4. **Los montos escritos no tenían ninguna validación.** La tabla no tiene CHECK y la RPC ya no los
   deriva de los ítems: un total negativo o absurdo corrompe el saldo del proveedor y el arqueo de
   caja. → validación en la RPC + CHECK en la tabla.
5. **La caja ya no exige estar abierta**: se auto-abre desde `20260720110000`. El spec afirmaba lo
   contrario y proponía un test que habría fallado.
6. **El recibo de pago cambiaba solo.** Sin número ni saldo congelado, reimprimir un recibo viejo
   mostraba el saldo de hoy. → `numero` y `saldo_posterior` en `proveedor_pagos`.
7. **La pantalla manual no capturaba el código del proveedor**, así que
   `producto_codigos_proveedor` —la tabla que hace que el segundo remito venga resuelto— dejaba de
   aprender. Se alimenta en `confirmar_ingreso_mercaderia`, no en la extracción, así que sacar la IA
   no la rompe: sacar el campo, sí.
8. **Los borradores con `bloqueo_confirmacion` no se pueden retomar a mano.** El spec afirmaba que
   sí. → se anulan y se rehacen, y la pantalla lo dice.
9. **El rate limit de `crear_borrador_ingreso`** estaba pensado para el gasto de la IA y trabaría la
   carga manual seguida. → se sube el tope.
10. **Los textos de la UI** siguen diciendo "suma stock" y "revierte stock", que para una compra sin
    ítems son mentira.
11. **Los permisos** no estaban decididos. → se mantienen, explícitamente.
12. `guardar_extraccion_ingreso` sí queda huérfana al borrar la server fn — confirmado.
