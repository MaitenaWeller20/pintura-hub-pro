# La caja no puede quedar en rojo, y las ventas a medio cobrar se cobran

**Fecha:** 2026-08-04
**Estado:** spec

---

## 1. Los dos hallazgos

Salieron de probar el sistema de punta a punta el 04/08.

### 1.1 La caja puede quedar en negativo

Con $47.671,57 cobrados en el día, el sistema dejó pagar **$221.000 en efectivo**
(una compra al contado de $121.000 y un pago a proveedor de $100.000). La caja
terminó en **−$173.328,43**.

Eso no puede pasar: no se saca de la caja plata que no está. Y arruina el arqueo
del día — al cerrar hay que declarar 0 contado y queda una diferencia de
+$173.328 que no significa nada.

### 1.2 Una venta al contado a medio cobrar queda en el limbo

Se vendió por $27.503,68 y se cobraron $10.000. La venta queda en `PARCIAL` con
$17.503,68 de saldo. Pero:

- **no aparece en Cuentas Corrientes**, que es donde cualquiera va a buscar quién
  debe plata;
- y, peor, **no hay ninguna forma de cobrar ese saldo**. La venta se queda en
  PARCIAL para siempre. Cuando el cliente vuelve con la plata, el sistema no
  tiene dónde registrarla.

Lo segundo es lo grave. La primera versión de este análisis lo llamó "un
problema de visibilidad"; mirando el código, la pantalla es la mitad chica del
problema.

## 2. Parte 1: guardar la caja del rojo

### 2.1 Qué se bloquea y qué no

El efectivo sale de la caja por **cinco** caminos. Se guardan **todos menos uno**:

| RPC | Se guarda | Por qué |
|---|---|---|
| `crear_compra` (contado, en efectivo) | ✅ | es una decisión discrecional |
| `registrar_pago_proveedor` (efectivo) | ✅ | ídem |
| `registrar_gasto` (efectivo) | ✅ | ídem |
| `registrar_movimiento_caja` (GASTO/RETIRO en efectivo) | ✅ | lo marcó el review |
| `crear_venta` con NOTA_CREDITO (pago negativo en efectivo) | ✅ | lo marcó el review |
| `anular_venta` (devolución en efectivo) | ❌ **NO** | es un camino de corrección |

La primera versión decía "el efectivo sale por cuatro caminos" y listaba tres.
Eran **cinco**: faltaban el retiro manual de caja y la nota de crédito cargada a
mano, que inserta `venta_pagos` con signo negativo. Con esos dos afuera, el
agujero seguía abierto.

`anular_venta` se deja pasar a propósito. Anular es cómo se arregla una venta mal
cargada: si el guard la bloqueara, alguien podría quedar atrapado con una venta
equivocada que no puede deshacer. Entre una caja en rojo y una venta falsa
inmortal, la caja en rojo es el mal menor — y queda a la vista en el arqueo.

Sólo se mira **el efectivo**. Una transferencia o un cheque no sacan plata del
cajón, y de hecho la salida que hoy propone el mensaje de error es justamente
esa.

### 2.2 Cómo se calcula lo que hay

Función nueva `efectivo_en_caja(_sesion_id)`, con la MISMA agregación que ya usa
`caja_esperado` pero filtrada a `EFECTIVO`:

```
  + venta_pagos            (por la venta y, de ahora en más, por el pago — §3.2)
  + cobranzas_cta_cte
  + caja_movimientos       (INICIAL e INGRESO suman; GASTO y RETIRO restan)
  − proveedor_pagos        (confirmados)
```

Se escribe como función y no se copia la cuenta en cada RPC: si mañana aparece
otra vía de plata, hay un solo lugar donde agregarla. Que `caja_esperado` y esto
puedan divergir es el riesgo, y por eso el test compara las dos.

### 2.3 Concurrencia: el advisory lock que ya existe

Verificar y después descontar es un clásico TOCTOU: dos pagos simultáneos leen
"hay $100.000", los dos pasan, y salen $200.000.

La primera versión de esta spec proponía `FOR UPDATE` sobre la fila de la caja.
**Estaba mal**, y el review lo frenó: `caja_sesion_actual()` ya sale con un
`FOR SHARE` sobre esa misma fila, así que pedir después un `FOR UPDATE` es una
escalada de lock — dos salidas simultáneas, cada una con su SHARE, esperándose
para subir a UPDATE. Eso es un deadlock, no una protección.

Lo que se usa es el **mismo advisory lock por sucursal** que `caja_sesion_actual`
ya toma (`pg_advisory_xact_lock(hash(sucursal_id))`). Es por transacción y
re-entrante, así que tomarlo de nuevo no cuesta nada cuando el llamador ya lo
tiene — que es casi siempre, porque los triggers de estampado lo toman al
insertar.

**El orden de locks tiene que ser único**: advisory primero, fila después.
`registrar_movimiento_caja` lo hacía al revés (tomaba la fila con `FOR UPDATE` y
recién ahí llamaba al guard) y eso abría un ABBA de manual. Ahora lee la
sucursal sin lock, toma el advisory, y recién entonces bloquea la fila.

Las ENTRADAS no se tocan: sólo suman, no pueden romper la invariante.

### 2.4 El mensaje tiene que ofrecer la salida

```
No hay suficiente efectivo en la caja: hay $47.671,57 y estás sacando
$121.000,00. Registralo como transferencia o cheque, o cargá el efectivo
que había al abrir el turno.
```

Un "no se puede" a secas dejaría a la clienta trabada un sábado a la mañana. Las
dos salidas son reales: cambiar la forma de pago, o cargar el fondo con
`registrar_movimiento_caja` (INGRESO), que ya existe.

## 3. Parte 2: cobrar el saldo de una venta

### 3.1 Por qué no alcanza con mandarlo a cuenta corriente

La tentación es convertir el saldo en deuda de cuenta corriente y reusar la
cobranza que ya existe. **No sirve**, por dos razones:

1. La cuenta corriente exige `clientes.condicion_cta_cte`, y la venta al contado
   típica es a **Consumidor Final**, que es un cliente **genérico y compartido**.
   Cargarle deuda sería juntar en una sola ficha lo que deben veinte personas
   distintas.
2. Una venta al contado a medio pagar no es una cuenta corriente: es *esta*
   venta la que quedó a medias. La deuda pertenece al comprobante, no a una
   cuenta.

### 3.2 El problema de fondo: `venta_pagos` no sabe de qué caja es

`venta_pagos` **no tiene `caja_sesion_id`**. El arqueo atribuye cada pago a la
caja por la venta (`ventas.caja_sesion_id`).

Mientras el pago es simultáneo a la venta da igual. Pero si el cliente vuelve el
jueves a pagar lo que debía del lunes, ese efectivo entra el **jueves** — y con
el modelo actual se sumaría a la caja del **lunes**, que ya está cerrada. El
arqueo del jueves daría de menos y el del lunes cambiaría después de cerrado.

Por eso:

```sql
ALTER TABLE venta_pagos ADD COLUMN caja_sesion_id uuid REFERENCES caja_sesiones(id);
```

y `caja_esperado` pasa a usar `COALESCE(vp.caja_sesion_id, v.caja_sesion_id)`. El
`COALESCE` es lo que hace que los pagos ya existentes —todos con la columna en
`NULL`— sigan contando exactamente donde contaban. **La migración no cambia
ningún arqueo pasado.**

### 3.3 La RPC nueva

```sql
cobrar_saldo_venta(p_venta_id, p_forma_pago, p_monto, p_detalle, p_idempotency_key)
```

Un pago por llamada, no un array: para cobrar un saldo que quedó, una forma
alcanza, y así la clave de idempotencia puede ser una columna con índice único
en vez de una tabla nueva.

- La venta tiene que estar `ACTIVA` y con saldo > 0.
- No se puede cobrar **más que el saldo**: el vuelto se da en el mostrador, no se
  inventa un pago de más.
- Los pagos se estampan con la sesión de caja **de hoy** (`caja_sesion_actual`),
  no con la de la venta.
- Recalcula `estado_pago`: queda `PAGADO` cuando el saldo llega a 0, si no sigue
  `PARCIAL`.
- `CTA_CTE` no es forma de pago acá, igual que en el resto del sistema.
- **Idempotencia de verdad**: con la misma clave no cobra dos veces Y devuelve el
  estado anterior en vez de un error. El índice único solo alcanzaría para lo
  primero, pero ante un timeout de red el cliente vería "error" de algo que sí
  entró — y reintentaría.
- Toma `FOR UPDATE` sobre la **venta**: dos cobros simultáneos del mismo saldo
  leerían los dos "faltan $10.000" y entrarían los dos. El lock de caja no sirve
  acá porque el cobro suma, no resta.
- Un cobro en efectivo **suma**, así que no necesita el guard de la parte 1.

### 3.4 Dónde se ve

Vista nueva `ventas_saldo_pendiente` (venta, cliente, fecha, total, cobrado,
saldo), y en **Cuentas Corrientes** un bloque propio: **"Ventas al contado sin
terminar de cobrar"**, con su botón de cobrar.

Bloque aparte y no mezclado con el saldo de cuenta corriente, a propósito: son
dos cosas distintas. Una es una cuenta abierta con un cliente habilitado; la otra
es un comprobante puntual que quedó a medias, y puede ser de Consumidor Final. Si
se sumaran en la misma columna, "Saldo" pasaría a significar dos cosas.

## 4. Lo que NO se toca

- **`anular_venta`.** Explicado en §2.1.
- **La regla de que al contado hay que cobrar algo.** Sigue igual.
- **El arqueo pasado.** El `COALESCE` de §3.2 lo garantiza.
- **`cuenta_corriente_saldos`.** La vista queda como está; el bloque nuevo es
  otra consulta.

## 5. Plan de pruebas

**SQL** (`scripts/test-caja-y-saldos.sh`, base local):

*Caja en rojo:*
1. con $10.000 en caja, un gasto en efectivo de $15.000 → **rechazado**
2. el mismo gasto por transferencia → **pasa**
3. un pago a proveedor en efectivo mayor que la caja → **rechazado**
4. una compra al contado en efectivo mayor que la caja → **rechazada**
5. una compra pagada mitad efectivo (dentro de lo que hay) y mitad transferencia
   → **pasa**
6. gasto exactamente igual al efectivo disponible → **pasa** (deja la caja en 0)
7. un peso más que eso → **rechazado**
8. anular una venta en efectivo con la caja en 0 → **pasa** (§2.1)
9. `efectivo_en_caja` coincide con el `EFECTIVO` de `caja_esperado`, en varios
   escenarios

*Saldo de venta:*
10. cobrar el saldo exacto → la venta queda `PAGADO`
11. cobrar una parte → sigue `PARCIAL` con el saldo bien
12. cobrar **más** que el saldo → rechazado
13. cobrar una venta ya pagada → rechazado
14. cobrar una venta anulada → rechazado
15. la misma clave de idempotencia dos veces → cobra una sola
16. el pago cae en la caja de HOY, no en la de la venta
17. un arqueo viejo no cambia después de la migración

**Playwright**: reproducir los dos casos reportados de punta a punta.

## 6. Review de la spec (Codex)

Diez hallazgos. Los dos críticos cambiaron el diseño antes de escribir una línea:

1. **El mapa de salidas de efectivo estaba incompleto.** Faltaban
   `registrar_movimiento_caja` (RETIRO/GASTO) y la nota de crédito manual, que
   inserta `venta_pagos` con signo negativo. Con esos dos afuera, el agujero
   seguía abierto por dos lados. Son cinco caminos, no tres.
2. **El `FOR UPDATE` que proponía la spec era un deadlock.** Ver §2.3.

Aceptados también: `cobrar_saldo_venta` necesita `FOR UPDATE` sobre la venta (dos
cobros concurrentes), idempotencia persistida, y mantener `ventas.total_pagado`
al día porque `anular_venta` lo usa para armar la nota de crédito.

Codex validó la decisión de no mandar el saldo a cuenta corriente y la exención
de `anular_venta`.

## 7. Review del código (Codex)

Ocho hallazgos, dos bloqueantes:

1. **BLOQUEANTE — deadlock ABBA en `registrar_movimiento_caja`.** Tomaba la fila
   de la caja con `FOR UPDATE` y recién después el advisory, al revés que
   `caja_sesion_actual`. Corregido: lee la sucursal sin lock, toma el advisory, y
   recién entonces bloquea la fila.
2. **BLOQUEANTE — los helpers estaban expuestos a `authenticated`.**
   `efectivo_en_caja` diría cuánta plata hay en cualquier caja con sólo saber su
   UUID, y `exigir_efectivo` filtraría lo mismo por el mensaje de error. Ninguno
   valida acceso. Corregido: no se otorgan; las RPC que los llaman son SECURITY
   DEFINER y los ven igual.
3. **ALTO — la idempotencia era sólo el índice único.** Un reintento después de
   un timeout recibía un error de algo que sí había entrado. Corregido: con la
   misma clave devuelve el estado actual.
4. **ALTO — `types.ts` quedó a medias**: faltaban las dos columnas nuevas de
   `venta_pagos`. Corregido.
5. **ALTO — no había ningún test de concurrencia**, que es justo lo que el guard
   viene a cerrar. Corregido con `scripts/test-caja-concurrencia.sh` (ver §8).
6. **MEDIO — el test de idempotencia era un falso verde**: probaba que el índice
   existía, no que cobrara una sola vez. Reescrito.
7. **MEDIO — faltaban casos** (cobrar una venta anulada). Agregado.
8. **MEDIO — la spec decía `FOR UPDATE`** y el código usa advisory. Alineado.

## 8. Verificación

**SQL secuencial** — `scripts/test-caja-y-saldos.sh`, 28 verdes: los cinco
caminos de salida, el caso exacto (gasto igual al efectivo pasa, un peso más no),
la mezcla efectivo+transferencia, `efectivo_en_caja` contra `caja_esperado`, y
todo el ciclo de cobro (saldo exacto, parcial, de más, venta pagada, venta
anulada, CTA_CTE, idempotencia). Con meta-test del helper `rechaza`.

**SQL concurrente** — `scripts/test-caja-concurrencia.sh`, 3 verdes:

- Dos gastos simultáneos de $7.000 contra una caja de $10.000: entra **uno**, la
  caja queda en $3.000. **Y se verificó que el test tiene dientes**: quitándole
  el guard a `registrar_gasto`, entran los dos y la caja queda en **−$4.000**,
  con las dos aserciones fallando.
- Sin deadlock entre `registrar_movimiento_caja` y `registrar_gasto` corriendo a
  la vez — que es exactamente el ABBA del punto 1.

**Playwright**, reproduciendo los dos hallazgos originales:

- Un gasto en efectivo con la caja en cero rebota con el mensaje completo, que
  llega tal cual a la pantalla. (De ahí salió un bug de formato: decía
  *"hay $.00"* porque `FM` se come el cero de las unidades.)
- Las dos ventas a medio cobrar aparecen en el tab nuevo con su saldo. Cobrar de
  más queda bloqueado; cobrar una parte actualiza la fila; al completar el saldo
  la venta desaparece del listado y queda `PAGADO`.
- En la base: los cobros posteriores llevan **su propia sesión de caja**, la caja
  vieja sigue en −$173.328,43 **sin cambios** (ningún arqueo pasado se movió), y
  la de hoy suma exactamente los $17.503,68 cobrados.
