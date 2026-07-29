# Presupuestos — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec revisado con Codex (§10, 6 hallazgos incorporados). Pendiente: implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §7.

---

## 1. El problema

> *"Tienen que poder hacer presupuestos que lógicamente cuando hacen presupuestos esos productos no
> se van del stock y ese monto tampoco se cobra, porque es un presupuesto para mandarle a cualquier
> cliente. Pero después, si ese cliente viene, ellos tienen que poder como asociar el presupuesto, y
> se les cargan todos los productos que habían puesto en el presupuesto con el precio que les habían
> hecho."*

Y sobre cómo lo encuentran: *"por la fecha o por el número"*.

Hoy **no existe nada**: `grep -ri presupuesto src/ supabase/` no devuelve una línea. Lo único
parecido es emitir un remito o una factura, que sí descuentan stock y sí cuentan como plata.

El sistema viejo (3C Informática) lo tenía en **Ventas → Presupuestos**, y de ahí lo sacaron.

---

## 2. Qué es un presupuesto acá

Un papel con precios, que no compromete nada:

| | Presupuesto | Venta |
|---|---|---|
| Descuenta stock | **no** | sí |
| Entra a la caja | **no** | sí |
| Genera deuda de cuenta corriente | **no** | sí |
| Cuenta en los reportes de ventas | **no** | sí |
| Va a AFIP | **no** | según el tipo |
| Se puede emitir sin cliente cargado | **sí** | no |

Lo único que hace es **congelar precios** para cuando el cliente vuelva.

---

## 3. Objetivos y no-objetivos

### Objetivos

1. Hacer un presupuesto con productos y precios, sin tocar stock ni plata.
2. Imprimirlo en PDF para mandárselo al cliente.
3. Buscarlo **por número o por fecha**.
4. Convertirlo en venta **con los precios que se presupuestaron**, aunque hayan cambiado.

### No-objetivos (YAGNI)

- **Convertir parcialmente.** "El cliente se lleva 3 de los 5 ítems" se resuelve convirtiendo y
  después editando la venta, que ya es un flujo que existe. Partir un presupuesto en dos es una
  máquina de estados que nadie pidió.
- **Versiones / revisiones del presupuesto.** Si cambian el precio, se hace otro.
- **Aprobación del cliente por link o mail.** No hay canal para eso.
- **Reservar stock.** El cliente fue explícito: *"esos productos no se van del stock"*.

---

## 4. Los datos

```sql
CREATE TABLE public.presupuestos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id        uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id         uuid NOT NULL REFERENCES auth.users(id),
  numero             text NOT NULL UNIQUE,          -- OHI-PRES-0001
  fecha              timestamptz NOT NULL DEFAULT now(),
  validez_hasta      date,                          -- vacío = sin vencimiento
  -- Un presupuesto se hace "para cualquier cliente": puede no haber ninguno
  -- cargado todavía. Por eso cliente_id es opcional y hay un nombre suelto.
  cliente_id         uuid REFERENCES public.clientes(id),
  nombre_cliente     text,
  subtotal_sin_iva   numeric(14,2) NOT NULL DEFAULT 0,
  iva_total          numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL DEFAULT 0,
  estado             text NOT NULL DEFAULT 'ABIERTO'
                       CHECK (estado IN ('ABIERTO','CONVERTIDO','ANULADO')),
  venta_id           uuid REFERENCES public.ventas(id),  -- la venta que salió de acá
  observaciones      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT presupuesto_convertido_tiene_venta
    CHECK ((estado = 'CONVERTIDO') = (venta_id IS NOT NULL))
);

CREATE TABLE public.presupuesto_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presupuesto_id   uuid NOT NULL REFERENCES public.presupuestos(id) ON DELETE CASCADE,
  producto_id      uuid NOT NULL REFERENCES public.productos(id),
  -- Snapshot: el presupuesto tiene que poder reimprimirse igual dentro de un mes,
  -- aunque al producto le hayan cambiado el nombre o lo hayan archivado.
  codigo           text NOT NULL,
  descripcion      text NOT NULL,
  cantidad         numeric(14,2) NOT NULL CHECK (cantidad > 0),
  -- El precio de catálogo y el descuento van POR SEPARADO: el presupuesto tiene
  -- que poder decir "te hago 10% sobre $1.000", no sólo "$900".
  precio_lista_sin_iva numeric(14,2) NOT NULL CHECK (precio_lista_sin_iva >= 0),
  descuento_porcentaje numeric(5,2)  NOT NULL DEFAULT 0
                         CHECK (descuento_porcentaje >= 0 AND descuento_porcentaje <= 100),
  precio_sin_iva   numeric(14,2) NOT NULL CHECK (precio_sin_iva >= 0),
  iva_porcentaje   numeric(5,2)  NOT NULL,
  subtotal_sin_iva numeric(14,2) NOT NULL,
  iva_monto        numeric(14,2) NOT NULL,
  subtotal_con_iva numeric(14,2) NOT NULL
);
```

El `CHECK` que ata `estado = 'CONVERTIDO'` con `venta_id IS NOT NULL` es lo que hace imposible el
estado incoherente "convertido pero no se sabe en qué venta", que es justo el que después nadie
puede explicar.

**Numeración:** `next_documento_numero(sucursal, 'PRESUPUESTO', 'PRES')`, la secuencia de documentos
**internos** creada en `20260729120000_compras_plata.sql`.

Deliberadamente **NO** se agrega `PRESUPUESTO` al enum `tipo_comprobante`: ese enum es el dominio
fiscal (ventas y AFIP), `next_comprobante_numero` tiene un `CASE` cerrado que falla si falta el
prefijo (`20260713130000_auditoria_correcciones.sql:25`), y `esComprobanteFiscal`
(`src/lib/fiscal/codigos.ts:32`) trata como fiscal todo lo que no esté en su lista de internos: un
presupuesto colado ahí quedaría fiscal por default. La secuencia interna tiene la misma garantía de
atomicidad, sin tocar el borde fiscal.

**RLS:** igual que ventas — admin ve todo, empleado ve su sucursal. Escritura sólo por las RPC.

---

## 5. Las tres operaciones

### 5.1 `crear_presupuesto(sucursal, cliente|nombre, validez, items[])`

Escribe cabecera e ítems en una transacción. **Los precios los pone el servidor**, leyéndolos de
`productos`, igual que `crear_venta`: el precio unitario no puede venir del navegador. Eso ya fue un
agujero de seguridad en este sistema y está documentado en
`20260713120000_seguridad_y_venta_atomica.sql:12`.

Se permite un **descuento por ítem** (es la razón de ser de un presupuesto: hacer un precio). El
descuento sí viene del cliente, pero acotado: `0 ≤ descuento ≤ 100`, y queda registrado. La
diferencia con aceptar un precio arbitrario es que el punto de partida sigue siendo el precio real
del catálogo.

No toca stock. No toca caja. No genera deuda.

### 5.2 `convertir_presupuesto_en_venta(presupuesto_id, cliente_id, tipo_comprobante, condicion, pagos)`

El corazón. En una transacción:

1. Bloquea el presupuesto (`FOR UPDATE`) y valida que esté `ABIERTO`. **Se convierte una sola vez**;
   el lock evita que dos personas lo conviertan a la vez y salgan dos ventas por la misma mercadería.
2. **Valida el cliente en la RPC**, no sólo en la pantalla: `ventas.cliente_id` es `NOT NULL` y
   `crear_venta` exige que exista y esté activo. Si el presupuesto ya tenía uno y se pasa otro, se
   permite —se hizo "para cualquier cliente"— y queda registrado cuál se usó.
3. Avisa —no bloquea— si está vencido.
4. Crea la venta **con los precios del presupuesto**.
5. Marca el presupuesto `CONVERTIDO` con su `venta_id`.

#### La decisión de §5.2, resuelta: NO se toca `crear_venta`

La premisa original de este spec estaba equivocada, y al mirar la función viva
aparece algo mejor todavía: **no hace falta tocar `crear_venta` en absoluto.**

`crear_venta` ya acepta `precio_unitario_sin_iva` por ítem, con
`COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista)`
(línea 188 de la definición viva). La UI se lo manda cuando alguien pisa el precio a mano.

Entonces `convertir_presupuesto_en_venta` sólo tiene que:

1. leer los ítems del presupuesto **de la tabla** (escrita por el servidor),
2. armar el `p_items` con esos precios,
3. llamar a `crear_venta` normalmente.

El precio no viene del navegador sino de una tabla que sólo escriben las RPC, así que la propiedad
de seguridad se mantiene sin agregar ningún parámetro nuevo ni extraer nada.

**Esto es estrictamente mejor que la opción "función interna":** cero cirugía sobre el corazón
transaccional del sistema (idempotencia, stock, caja, límite de crédito, numeración, AFIP), cero
riesgo de que dos copias se separen, cero `DROP FUNCTION` sobre una firma de 12 parámetros. El
review pedía no duplicar; la respuesta correcta resultó ser no tocar.

#### El orden de los locks

La conversión hereda de `crear_venta` el bloqueo de productos **en el orden del payload**. Dos
ventas con los mismos productos en distinto orden pueden deadlockear — un problema que ya existe
hoy y que este chunk no trae.

Como no se toca `crear_venta`, la mitigación va donde sí se puede: **la conversión arma su `p_items`
ordenado por `producto_id`**. Dos conversiones concurrentes de presupuestos que comparten productos
piden los locks en el mismo orden, así que entre ellas no hay ciclo. Contra una venta manual el
riesgo preexistente sigue igual, y arreglarlo es cirugía sobre `crear_venta` que no vale la pena
para este chunk.

(Contra `cambiar_precios_masivo` no hay riesgo: su `LOCK TABLE ... SHARE ROW EXCLUSIVE` no choca con
el `ROW SHARE` de un `SELECT FOR UPDATE`.)

### 5.3 `anular_presupuesto(id)`

Sólo si está `ABIERTO`. Un presupuesto convertido no se anula: se anula la venta, que ya tiene su
propio circuito con nota de crédito.

---

## 6. Las pantallas

**`/presupuestos`** — listado con número, fecha, cliente, total y estado. Buscador por número o
nombre, y filtro de período (los mismos componentes que ya usan Ventas y Pagos). Es exactamente el
*"por la fecha o por el número"* del cliente.

**`/presupuestos/nuevo`** — mismo layout que `/ventas/nueva`, que la empleada ya sabe usar: buscar
producto, cantidad, descuento, y el total abajo. Cliente opcional: se puede elegir uno cargado o
escribir un nombre suelto.

**Detalle** — el presupuesto con sus ítems, **Imprimir PDF** y **Convertir en venta**. Al convertir
se pide el cliente (obligatorio acá), el tipo de comprobante y la forma de pago; los productos y los
precios ya vienen. Si el presupuesto está vencido, un cartel amarillo lo dice y deja seguir.

Un presupuesto ya convertido muestra un link a su venta, y viceversa.

**El PDF** dice **"PRESUPUESTO"** grande y **"No válido como factura"**, con la validez. Este
sistema emite comprobantes fiscales de verdad; un papel con precios que se pueda confundir con una
factura es un problema con AFIP, no un detalle de diseño.

---

## 7. Qué NO se toca

- **`crear_venta`** en su comportamiento actual: mismo resultado para todas las ventas que no vienen
  de un presupuesto.
- **Stock, caja, cuenta corriente y facturación.** Un presupuesto no los mira hasta que se convierte.
- **Los reportes de ventas.** Los presupuestos no suman ahí, por definición.

---

## 8. Verificación

**SQL (`scripts/test-presupuestos.sh`):**
- Crear un presupuesto **no** mueve stock, **no** mueve caja, **no** genera deuda.
- Los precios los pone el servidor: mandar un precio inventado no cambia el guardado.
- El descuento por ítem se respeta y se rechaza fuera de `[0,100]`.
- **Convertir usa el precio del presupuesto, no el de hoy**: se presupuesta a $10.000, se cambia el
  precio del producto a $15.000, se convierte → la venta dice $10.000.
- Convertir **descuenta stock, mueve caja y genera la deuda** igual que una venta normal.
- **Convertir dos veces falla**, y dos conversiones concurrentes dejan UNA sola venta.
- Un presupuesto vencido se puede convertir (avisa, no bloquea).
- Anular uno convertido falla; anular uno abierto anda.
- Un empleado no ve los presupuestos de otra sucursal.
- El `CHECK` de coherencia rechaza `CONVERTIDO` sin `venta_id`.

**e2e con navegador:** hacer un presupuesto, bajar el PDF, convertirlo, y ver que la venta tiene los
productos con los precios presupuestados.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 9. Orden de implementación

1. Migración: tablas, tipo `PRESUPUESTO` en la numeración, RLS, y las tres RPC (con la decisión de
   §5.2 ya tomada).
2. `/presupuestos` (listado) y `/presupuestos/nuevo`, reusando los componentes de `/ventas/nueva`.
3. Detalle + PDF.
4. Conversión, con su diálogo.
5. Tests SQL + e2e.

Nada de esto cambia el comportamiento de lo que ya existe: es una entidad nueva, al lado.

---

## 10. Hallazgos del review del spec con Codex

1. **BLOQUEANTE — la premisa de §5.2 estaba equivocada**: `crear_venta` ya acepta precio externo por
   ítem. Mirando la función viva se llegó a algo mejor que las dos opciones que el spec proponía:
   **no tocar `crear_venta`**. La conversión le pasa los precios leídos de `presupuesto_items` —una
   tabla que sólo escriben las RPC— por el parámetro que ya existe. Cero cirugía sobre el corazón
   transaccional.
2. **BLOQUEANTE — `PRESUPUESTO` no puede entrar al enum `tipo_comprobante`**: es el dominio fiscal, y
   `esComprobanteFiscal` trata como fiscal todo lo que no esté en su lista de internos. → la
   secuencia de documentos internos, que ya quedó hecha en el chunk de compras.
3. **La función se llama `next_comprobante_numero`**, no `siguiente_numero_comprobante`.
4. **El orden de los locks de productos** puede deadlockear entre dos conversiones. → la interna
   ordena por `producto_id`.
5. **El cliente hay que validarlo en la RPC**, no sólo en la pantalla.
6. **Faltaba la columna del descuento**: el spec decía que quedaba registrado y la tabla no lo
   guardaba.

---

## 11. Hallazgos del review adversarial del código

Dos de plata, reproducidos contra la base local antes de arreglarlos.

1. **ALTA — la clave de idempotencia la elegía quien llamaba.** `crear_venta` cortocircuita si ya
   existe una venta con esa clave y devuelve **la venta vieja**; la conversión no distinguía "venta
   nueva" de "venta preexistente". Mandando la misma clave en dos presupuestos distintos, el segundo
   quedaba `CONVERTIDO` apuntando a la venta del primero: la mercadería nunca salía del stock y nadie
   la cobraba. Reproducido: dos presupuestos de 1 y 9 unidades, el stock bajó 1 en vez de 10.
   → la clave la deriva la RPC del propio `p_presupuesto_id`, más un índice único sobre `venta_id`.
2. **ALTA — el tipo de comprobante se limitaba sólo en el `<Select>`.** Por RPC directa: `REMITO` +
   `CONTADO` cobra sin que la plata entre a la caja; `FAC_INTERNA_CTA_CTE` + `CTA_CTE` saca stock sin
   deuda y sin pago. → el guard se movió adentro de la RPC (sólo `FACTURA_A/B/C`).
3. **MEDIA — el pago se registraba siempre como `EFECTIVO`.** El arqueo compara el bucket EFECTIVO
   contra la plata contada, así que cada conversión cobrada por transferencia dejaba un faltante de
   caja por ese monto. → selector de forma de pago en el diálogo de conversión.
4. **MEDIA — `eliminar_productos` reventaba con la FK de `presupuesto_items`.** El producto caía en
   la rama del `DELETE` real y la excepción abortaba toda la transacción: un borrado masivo de 50
   productos no borraba ninguno. → un presupuesto cuenta como historial, se archiva. Archivar toca
   `archivado` y `crear_venta` mira `activo`, así que el presupuesto abierto se sigue pudiendo
   convertir.
5. **MEDIA — TOCTOU entre el guard de IVA y el lock.** Se validaba el IVA y recién después
   `crear_venta` tomaba los locks. → los productos se lockean ordenados por id **antes** del guard.
6. **BAJA — `NaN` pasaba las validaciones.** `NaN <= 0` es `false` y `NaN > 0` es `true`, así que ni
   la comparación ni el CHECK lo atrapaban, y el total quedaba en `NaN`. → rechazo explícito
   (`= 'NaN'::numeric`) más un CHECK que exige un número real.
7. **BAJA — el link a la venta no iba a ninguna parte útil.** → el aviso ahora dice que la venta
   lleva el número del presupuesto en sus observaciones.

---

## 12. Hallazgos del code review de Codex

1. **ALTA — la clave derivada chocaba con las ventas normales.** Usar `p_presupuesto_id` tal cual
   como `idempotency_key` lo mete en el mismo espacio que las claves que manda la pantalla de ventas:
   si ya existía una venta con esa clave, `crear_venta` la devolvía y el presupuesto quedaba
   `CONVERTIDO` apuntando a una venta ajena, sin ítems propios, sin stock ni cobro. → la clave sale
   de un hash con prefijo (`md5('presupuesto:' || id)`) y, además, si esa venta ya existe con el
   presupuesto todavía abierto, la RPC corta: eso no puede ser un reintento nuestro.
2. **ALTA — una conversión CONTADO sin pagos sacaba la mercadería gratis.** La venta quedaba
   `CONTADO` / `PENDIENTE` / `total_pagado = 0`: no entra a la caja y tampoco genera deuda de cuenta
   corriente, así que la plata no aparece en ningún lado. La pantalla siempre manda el total; la RPC
   ahora lo exige. *(La misma permisividad existe en `crear_venta` para todos los flujos: es de
   antes, queda anotada.)*
3. **MEDIA — reintentar una conversión que sí funcionó daba error.** Si se perdía la respuesta, el
   segundo intento moría en "ya está convertido" aunque la venta existiera. → devuelve esa misma
   venta, que es lo que promete una operación idempotente; sólo avisa si le mandan otro cliente.
4. **MEDIA — deadlock entre la conversión y una venta manual.** El orden canónico de locks estaba
   sólo en la conversión: `crear_venta` lockea los productos en el orden en que vengan en `p_items`,
   así que dos cajas con los mismos dos productos en distinto orden se traban cruzadas. El problema
   es viejo y de `crear_venta`. → un `PERFORM … ORDER BY p.id FOR UPDATE` antes del loop, aditivo,
   escrito sobre la definición **viva** (que es la de `r5_nota_debito_recargo`, no la de `r6`:
   verificado con `diff` contra `pg_proc`).
5. **MEDIA — listados truncados.** El listado bajaba los últimos 300 y filtraba en memoria: buscar un
   presupuesto viejo por número no lo encontraba nunca. Los clientes se cargaban con `limit(500)`,
   así que el 501 no se podía elegir. Y el spec prometía buscar **por fecha** (palabras de la
   clienta) y eso no estaba. → filtros al servidor, rango de fechas, y un `ClientePicker` que busca
   contra PostgREST. Cuando el listado llega al tope, el subtítulo lo dice.
6. **BAJA — `producto_tiene_presupuesto` quedaba suelta.** Cualquier autenticado podía preguntar si
   un producto figura en presupuestos que su RLS no lo deja leer. → `REVOKE` (la usa sólo
   `eliminar_productos`, que corre como dueña) más el índice por `producto_id` que la FK no crea.
