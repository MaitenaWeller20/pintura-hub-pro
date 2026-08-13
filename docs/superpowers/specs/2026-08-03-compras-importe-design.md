# Nueva compra: el importe se carga como lo dice la factura

**Fecha:** 2026-08-03
**Estado:** spec
**Pantalla:** `/compras/nueva` (`src/routes/_authenticated/compras.nueva.tsx`)

---

## 1. Lo que reportó la clienta

Textual, con fotos:

> "Acá estoy cargando una nueva compra y nada, ya completé todos los datos, forma
> de pago y el monto que hay que pagar, pero **no me deja guardar la compra**."

> "Y cuando pongo un proveedor con cuenta corriente **no me deja tampoco ingresar
> el monto**."

> "Ahí puse ahí al costado, tipo el monto, y sí me deja guardarlo."

> "¿O qué es percepciones? Debería venir como… las compras ya vienen con el IVA.
> Deberían poner ellos: **total**, no total sin IVA. Y después sí, capaz, dejarlo
> el IVA por las dudas que alguna venga sin IVA, y calcular el porcentaje, porque
> acá **no me deja agregar el porcentaje**, me deja agregar nada más números."

## 2. Qué pasa realmente

Ninguna de las dos cosas es un error del servidor. Las dos son la misma causa: el
importe de la compra se carga en tres inputs chiquitos adentro de la tarjeta
"Totales", a la derecha, y **no se leen como campos para escribir**.

### 2.1 "No me deja guardar" (foto 1)

En la foto: `Subtotal s/IVA` y `IVA` vacíos, `Percepciones` en 0, un pago en
efectivo de 120.000.

```ts
const total = r2(sub + iva + r2(Number(percepciones || 0)));   // 0 + 0 + 0 = 0
const pagosOk = esCtaCte || Math.abs(totales.pagado - totales.total) <= 0.01;
const canSave = … && totales.total > 0 && pagosOk;             // false
```

`Guardar` queda deshabilitado **y no dice por qué**. El único indicio es el texto
rojo "Los pagos deben cubrir exactamente el total", que apunta al lugar
equivocado: el problema no son los pagos, es que el total nunca se cargó.

### 2.2 "A pagar: $120.000" al lado de "TOTAL: $0,00" (foto 1)

El rótulo miente. La línea dice `A pagar` pero muestra `totales.pagado`, que es la
**suma de los pagos ya cargados**. Con el total en 0 y un pago de 120.000 la
pantalla afirma que hay que pagar 120.000 de una compra que vale 0.

### 2.3 "Con cuenta corriente no me deja ingresar el monto" (foto 2)

Con `CTA_CTE` la tarjeta "Formas de pago" desaparece entera (`{!esCtaCte && …}`),
que es correcto —una compra a cuenta no lleva pagos—, pero con ella desaparece el
**único campo que se llamaba "Monto"**. Quedan sólo los tres inputs chiquitos de
Totales, que ya no se habían reconocido en el caso anterior.

### 2.4 El modelo mental está al revés

Una factura de compra llega con un **TOTAL**, con IVA adentro. Pedir primero
"Subtotal s/IVA" obliga a hacer a mano una cuenta que el papel ya trae hecha. El
comentario que hay hoy en el código justifica esa decisión así:

> "El IVA va suelto y no derivado de un porcentaje único: en una factura real
> conviven alícuotas distintas y percepciones, y recomponerlo sería inventar un
> número que no está en el papel."

El razonamiento es correcto **para el caso raro** (factura con alícuotas mezcladas)
y equivocado como default: el 95% de las compras son una alícuota sola. La forma
correcta es invertir la prioridad — el total manda, el desglose es opcional — sin
perder la posibilidad de escribir el IVA a mano cuando la factura es mixta.

## 3. Diseño

### 3.1 La tarjeta pasa a llamarse "Importe de la compra"

```
┌─ Importe de la compra ───────────────────────────┐
│ Total del comprobante *                          │
│ ┌──────────────────────────────────────────────┐ │
│ │ 120000                                       │ │   ← grande, ancho completo
│ └──────────────────────────────────────────────┘ │
│ El número final que dice la factura o el remito, │
│ con el IVA ya incluido.                          │
│                                                  │
│ ▸ Desglosar el IVA (opcional)                    │
│                                                  │
│ ─────────────────────────────────────────────    │
│ TOTAL:                            $ 120.000,00   │
│ Va a deuda / Pagado:              $ 120.000,00   │
└──────────────────────────────────────────────────┘
```

Desplegando el desglose:

```
│ ▾ Desglosar el IVA (opcional)                    │
│   IVA incluido:  [ 21%            ▾ ]            │
│                  Sin desglosar / 21% / 10,5% /   │
│                  27% / 5% / 2,5% / Otro monto    │
│   Percepciones:  [ 0 ]  (?)                      │
│                                                  │
│   Neto s/IVA:                      $ 99.173,55   │
│   IVA (21%):                       $ 20.826,45   │
```

Esto resuelve las tres cosas que pidió: se carga el **total**, el IVA se puede
poner **por porcentaje** (y también a mano, "por las dudas que alguna venga sin
IVA"), y percepciones deja de estar en primer plano con un cartel que explica qué
es.

### 3.2 La cuenta

Se elige **derivar el neto del total**, no al revés. El total es el dato duro (está
impreso); el neto es el derivado.

```ts
base = total − percepciones
iva  = modo === "tasa"  ? r2(base − base / (1 + tasa/100))
     : modo === "manual" ? r2(ivaManual)
     : 0
neto = r2(base − iva)
```

`neto + iva + percepciones === total` **exacto a dos decimales**, por construcción:
el neto es el residuo, no un tercer redondeo independiente. Esto importa porque el
servidor recalcula `v_total := ROUND(v_sub + v_iva + v_perc, 2)` y guarda **ese**
número; si acá redondeáramos los tres por separado, la compra podría guardarse con
un centavo distinto del que la clienta escribió, y ese centavo termina en la deuda
del proveedor.

La RPC `crear_compra` **no se toca**: sigue recibiendo
`p_subtotal_sin_iva / p_iva_total / p_percepciones`. El cambio es de captura, no de
modelo de datos.

### 3.3 Validaciones nuevas

| Situación | Qué pasa |
|---|---|
| `percepciones > total` | Error visible, `Guardar` bloqueado: "Las percepciones no pueden ser más que el total." |
| `ivaManual > base` | Error visible, `Guardar` bloqueado: "El IVA no puede ser más que el total." |
| `total <= 0` | `Guardar` bloqueado (ya era así) **y ahora dice por qué**. |

### 3.4 El botón deshabilitado tiene que decir qué falta

Se calcula un `faltante: string | null` con el primer requisito incumplido
(sucursal, proveedor, N° de comprobante, fecha, total, pagos) y se muestra como
línea al lado de `Guardar`, además de ir en el `title` del botón. Un botón gris sin
explicación es exactamente el problema que trajo la clienta.

### 3.5 Rótulos de pago

- `A pagar:` → `Pagado:` (es lo que ya se cargó).
- Se agrega `Falta: $X` en rojo cuando `pagado < total`, y `Sobra: $X` cuando se
  pasa. El texto genérico "Los pagos deben cubrir exactamente el total" queda como
  ayuda secundaria.

### 3.6 El pago se pre-carga solo (contado)

Hoy hay que apretar "Agregar pago" y escribir el monto de nuevo, habiendo escrito
ya el total. En una compra al contado el pago es el total, casi siempre en efectivo.

Comportamiento: mientras la persona **no haya tocado** los pagos, se mantiene una
única fila `EFECTIVO` con `monto = total`, sincronizada con el total. Al primer
`Agregar pago` / cambio de monto / borrado, se levanta un flag `pagosTocados` y la
sincronización se apaga para siempre (no se le pisa nada a nadie).

Al pasar a `CTA_CTE` los pagos se limpian y `pagosTocados` se resetea, para que al
volver a contado el auto-completado siga funcionando.

## 4. Dos bugs vecinos que se arreglan de paso

Aparecieron leyendo el archivo; los dos son de la misma familia que ya mordió antes.

### 4.1 `crypto.randomUUID()` revienta fuera de contexto seguro

`compras.nueva.tsx:118` usa `crypto.randomUUID()` para el id de la fila de pago.
Esa API **no existe** si la página se abre por IP de LAN sobre `http://` — es
idéntico al bug que se corrigió el 24/07 en el conteo físico, y por eso existe
`src/lib/uuid.ts`. Si la clienta entra desde otra máquina de la red por IP,
"Agregar pago" tira `TypeError` y no pasa nada. Se cambia por `uuidv4()`.

### 4.2 La condición no se resetea al cambiar de proveedor

`CTA_CTE` sólo se puede elegir si `provSel.condicion_cta_cte`, pero el `SelectItem`
deshabilitado no impide que el **estado ya elegido** sobreviva: proveedor A (con
cuenta corriente) → `CTA_CTE` → cambio a proveedor B (sin cuenta corriente) → la
condición sigue en `CTA_CTE`, la UI oculta los pagos, y recién el servidor rechaza
con "El proveedor B no tiene cuenta corriente habilitada". Se agrega un efecto que
vuelve a `CONTADO` cuando el proveedor seleccionado no tiene cuenta corriente.

## 5. Lo que NO se cambia, y por qué

- **La RPC `crear_compra`.** No hay migración. El bug es de captura.
- **Que compras no sume stock.** El cartel se queda tal cual; es la lección del
  envase.
- **Que una compra contado se pague entera.** Es una regla del servidor
  (`ABS(v_monto - v_total) > 0.01`), no un capricho de la UI. Distinto del caso de
  *ventas* al contado, donde el 29/07 se aceptó el pago parcial: ahí el que decide
  es el cliente que se lleva la mercadería; acá el que decide es el proveedor y la
  plata sale de la caja.
- **Alícuotas mezcladas.** Siguen soportadas vía "Otro monto", que es el caso que
  el comentario original quería proteger.

## 6. Plan de pruebas

**Unitarias** (`src/lib/compras-importe.ts` + `.test.ts` — la cuenta se extrae a un
módulo para poder testearla sin montar la pantalla):

1. total 120000, 21% → neto 99173.55, iva 20826.45, suma exacta 120000
2. total 121, 21% → neto 100, iva 21
3. total 100, sin desglosar → neto 100, iva 0
4. total 121000, perc 1000, 21% → base 120000 → neto 99173.55, iva 20826.45, suma 121000
5. iva manual mayor que la base → inválido
6. percepciones mayores que el total → inválido
7. total 0 / null → inválido
8. **propiedad**: para 10.000 totales aleatorios y todas las alícuotas,
   `neto + iva + perc === total` sin excepción (es la invariante que protege la
   deuda del proveedor)
9. 10,5% sobre un total capicúa (chequeo de redondeo medio-hacia-arriba)

**End-to-end** (`scripts/test-compras-importe.sh`, contra la base local):
- compra contado con total + IVA 21% → la fila queda con los tres montos y suman
- compra cta cte → `proveedor_cc_movimientos` con el débito por el total exacto
- percepciones > total → rechazada

**Playwright** (obligatorio antes de desplegar, memoria `probar-con-playwright`):
reproducir la foto 1 tal cual —cargar sólo el total y el pago— y verificar que
`Guardar` se habilita; después la foto 2 con cuenta corriente.

## 7. Review de la spec (Codex)

Cinco hallazgos, cuatro aceptados:

1. **El auto-pago en EFECTIVO puede guardar un pago que nadie quiso.** Aceptado, y
   es el más grave: una compra al contado saca plata de la caja de verdad, y a un
   proveedor se le suele pagar por transferencia o cheque. **La forma de pago
   arranca vacía**; se pre-carga el monto (que ya es dato) y no la decisión.
2. **Resetear `pagosTocados` al pasar por `CTA_CTE` pisa una decisión explícita.**
   Aceptado. No se resetea nada, y además **los pagos ya no se borran** al cambiar
   la condición: se ocultan y no se mandan. Probar "cuenta corriente" y volver ya
   no cuesta perder el detalle de la transferencia escrito.
3. **`Number` + `toFixed` no alcanza para prometer igualdad con `numeric`.**
   Aceptado. **Toda la cuenta pasó a centavos enteros**: `neto + iva + perc ===
   total` deja de depender del redondeo y pasa a ser aritmética de enteros.
4. **"Sin desglosar" como default rompe el significado de `iva_total`.** Aceptado,
   y era un bug de datos silencioso: cada Factura A habría quedado con IVA cero.
   El default lo decide ahora el **tipo de comprobante** (`MODO_IVA_POR_TIPO`).
5. **"Falta $0,01" con `Guardar` habilitado.** Aceptado: `faltanteCompra` usa la
   MISMA tolerancia de un centavo que la RPC.

Sobre-diseño señalado: el property test de 10.000 casos aleatorios no cubre los
redondeos peligrosos. Se conservó uno acotado (5.000, semilla fija, hasta el tope
de la RPC) **más** una batería dirigida de casos `x.xx5`, que es donde falla.

## 8. Review del código (Codex)

Cinco hallazgos, todos corregidos:

1. **El tope de la RPC no estaba replicado** (`LIMITE := 999999999`). La UI
   habilitaba Guardar y el servidor rechazaba. → `TOPE_TOTAL` en `faltanteCompra`.
2. **Los pagos validados no eran los que se mandan.** El payload filtra
   `monto > 0`, pero la validación exigía forma de pago en TODAS las filas: una
   fila vacía de $0 trababa Guardar por algo que el servidor nunca iba a ver. →
   mismo filtro en los dos lados. Y al revés: un total de **$0,01 sin ningún
   pago** pasaba por la tolerancia (la RPC también lo aceptaba) → quedaba plata
   saliendo de la caja sin rastro. Ahora se exige al menos un pago con monto.
3. **Borrar el total perdía la forma de pago elegida.** Con el total en cero se
   vacía el monto, no se borra la fila.
4. **La RPC no valida `forma_pago` con regla propia**: por llamada directa el
   error saldría del CHECK de `proveedor_pagos`, no del negocio. **No corregido a
   propósito** — arreglarlo obliga a reescribir las 130 líneas de `crear_compra`
   con `CREATE OR REPLACE`, que es justo la maniobra que ya causó dos regresiones
   (ver `20260729140000_compras_fixes_review.sql`). La pantalla lo bloquea y el
   CHECK lo ataja; el riesgo del arreglo es mayor que el del bug. Anotado.
5. **El input mostraba `1.005` y se guardaba `1.01`.** → `redondearACentavos` en
   todos los campos de plata.

## 9. Verificación

- 30 tests unitarios de `compras-importe`, 208 en total. `tsc` limpio.
- Playwright contra la base local, reproduciendo las dos fotos:
  - **Foto 1 (contado):** total 120.000 → neto $99.173,55 + IVA $20.826,45, pago
    pre-cargado en 120.000, `Guardar` deshabilitado diciendo *"Elegí con qué se
    pagó la compra."*; al elegir Efectivo se habilita y guarda. En la base:
    `subtotal + iva + percepciones = total` exacto.
  - **Foto 2 (cuenta corriente):** el total se carga sin problema, "Va a deuda
    $120.000,00", y queda el `DEBITO` por $120.000,00 en
    `proveedor_cc_movimientos`.
  - Default de IVA por tipo: Factura A → 21%, Remito y Factura B → sin desglosar.
- Sin errores de consola.
