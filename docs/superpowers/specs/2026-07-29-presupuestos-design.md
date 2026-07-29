# Presupuestos — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec escrito. Pendiente: review con Codex, implementación.
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

**Numeración:** se reusa `siguiente_numero_comprobante(sucursal, tipo)`, que ya existe y ya es
atómica (`20260630021321…sql:83`). Se le suma el tipo `PRESUPUESTO` con prefijo `PRES`. Reusarla es
lo correcto: escribir una numeración propia sería repetir un problema de concurrencia ya resuelto.

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

1. Bloquea el presupuesto (`FOR UPDATE`) y valida que esté `ABIERTO`. **Un presupuesto se convierte
   una sola vez**; el lock es lo que evita que dos personas lo conviertan a la vez y salgan dos
   ventas por la misma mercadería.
2. Avisa —no bloquea— si está vencido: la decisión de respetar un precio viejo es del negocio.
3. Crea la venta **con los precios del presupuesto**, no con los de hoy. Este es el punto de toda la
   feature.
4. Descuenta stock, mueve caja y genera la deuda: de acá en adelante es una venta normal.
5. Marca el presupuesto `CONVERTIDO` y le guarda el `venta_id`.

**Cómo se implementa sin duplicar `crear_venta`.** `crear_venta` calcula los precios desde
`productos` y no acepta precios de afuera —correctamente—. Duplicar sus ~200 líneas (stock, caja,
cuenta corriente, numeración, validaciones) para cambiar de dónde sale un número sería garantizar
que las dos copias se separen con el tiempo.

Entonces: se le agrega a `crear_venta` un parámetro `p_precios_congelados jsonb DEFAULT NULL`, que
**sólo `convertir_presupuesto_en_venta` usa**, pasándole los precios que leyó de
`presupuesto_items` dentro de la misma transacción. Como el valor no viene del navegador sino de una
tabla escrita por el servidor, la propiedad de seguridad se mantiene. Y para que no se pueda abusar
desde afuera, la RPC de conversión es la única con permiso de pasarlo: `crear_venta` rechaza
`p_precios_congelados` si el llamador no es la otra RPC (se valida con un parámetro interno que la
UI no conoce; alternativa más simple y preferida si el review lo confirma: mover el cuerpo común a
una función interna `_crear_venta_interna` que las dos llamen, y dejar `crear_venta` como la puerta
pública sin ese parámetro).

**La decisión concreta a validar con Codex:** función interna compartida (preferida) vs. parámetro
extra en `crear_venta`. Las dos evitan la duplicación; la primera evita además tener que custodiar
un parámetro peligroso en la puerta pública.

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
