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

#### La decisión de §5.2, resuelta: función interna compartida

La premisa original de este spec estaba **equivocada**. `crear_venta` **ya acepta un precio de
afuera**: toma `precio_unitario_sin_iva` por ítem con `COALESCE(..., v_precio_lista)`
(`20260721170000_r5_nota_debito_recargo.sql:222`), y la UI se lo manda cuando alguien pisa el precio
a mano (`ventas.nueva.tsx:425`). El "agujero" que yo quería preservar ya está abierto por diseño.

Aun así, **agregar un `p_precios_congelados` público sería peor**: un parámetro peligroso en la
puerta pública no se protege con "la UI no lo conoce".

**Se extrae el cuerpo vigente de `crear_venta` a `_crear_venta_interna`, sin `GRANT` público**, y
`crear_venta` queda como wrapper. `convertir_presupuesto_en_venta` llama a la interna. Comparten
todo: idempotencia con advisory lock, auth de sucursal, cliente activo, coherencia de Factura A,
percepciones, stock negativo por perfil, notas asociadas, límite de crédito, numeración, stock con
kardex, pagos con vuelto y cuenta corriente. Nada se duplica.

**Cambiar la firma exige `DROP FUNCTION` primero** — el mismo problema que ya documenta
`20260718121000_g4_validaciones_crear_venta.sql:26` y que apareció en el chunk de compras.

#### El orden de los locks

La conversión hereda de `crear_venta` el bloqueo de productos **en el orden del payload**
(`20260721170000…sql:207`). Dos ventas con los mismos productos en distinto orden pueden
deadlockear — un problema que ya existe hoy, no lo trae este chunk. Aprovechando que se toca el
núcleo, **la interna ordena los ítems por `producto_id` antes de bloquear**, que es la forma barata
de que no haya ciclo.

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
   ítem. Aun así, un parámetro público nuevo sería peor que extraer el núcleo. → función interna sin
   GRANT, decisión tomada y justificada.
2. **BLOQUEANTE — `PRESUPUESTO` no puede entrar al enum `tipo_comprobante`**: es el dominio fiscal, y
   `esComprobanteFiscal` trata como fiscal todo lo que no esté en su lista de internos. → la
   secuencia de documentos internos, que ya quedó hecha en el chunk de compras.
3. **La función se llama `next_comprobante_numero`**, no `siguiente_numero_comprobante`.
4. **El orden de los locks de productos** puede deadlockear entre dos conversiones. → la interna
   ordena por `producto_id`.
5. **El cliente hay que validarlo en la RPC**, no sólo en la pantalla.
6. **Faltaba la columna del descuento**: el spec decía que quedaba registrado y la tabla no lo
   guardaba.
