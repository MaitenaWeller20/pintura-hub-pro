# Seguimiento de un producto — Diseño

**Fecha:** 2026-07-29
**Estado:** Spec revisado con Codex (§8, 4 hallazgos incorporados). Pendiente: implementación.
**Viene de:** `2026-07-29-correcciones-cliente-backlog.md` §8.

---

## 1. El problema

> *"Esto de hacer seguimiento de un producto me dice que es muy importante, porque es lo que hace la
> mayor parte del tiempo. ¿Usted cuándo ingresó un pincel? ¿Cuántas cantidades ingresaron? Y en el
> tiempo, ¿cómo se fue vendiendo? ¿Se ingresaron más unidades? Si la gente se lo llevó como cuenta
> corriente. Quieren ver el avance de los productos y ellos seleccionar qué producto quieren ver."*

Es la pantalla **"Seguimiento de Artículos"** del sistema viejo (foto del cliente): elegís un
artículo y un depósito, y sale la lista de todo lo que le pasó — fecha, artículo, persona, sucursal,
número de comprobante y origen.

Hoy la data **ya está toda** en `stock_movimientos`: cada entrada y salida deja fila con
`producto_id`, `sucursal_id`, `tipo`, `cantidad`, `cantidad_anterior`, `cantidad_nueva`,
`referencia_id` y `usuario_id` (`20260629211713…sql:153`). Lo que no hay es **la pantalla**, y falta
una cosa que el cliente sí pide: **con quién** fue cada movimiento.

`referencia_id` guarda el id de la venta / remito / compra / ingreso, pero es un `uuid` suelto sin
foreign key ni tabla que diga de qué es. Para poner "PORTA HNOS SA" al lado de una salida hay que
resolverlo por `tipo`.

---

## 2. Objetivos y no-objetivos

### Objetivos

1. Elegir un producto y ver **toda su historia**, ordenada en el tiempo.
2. Que cada línea diga **qué pasó, cuánto, con quién y con qué comprobante**.
3. Que se vea el **saldo corriendo**, para entender cómo llegó al stock de hoy.
4. Filtrar por sucursal y por período.

### No-objetivos (YAGNI)

- **Valorizar el movimiento** (costo promedio, PEPS, margen por unidad). No se pidió y abre una
  discusión contable entera.
- **Cambiar `stock_movimientos`** o agregarle columnas. La data está; falta leerla.
- **Un reporte imprimible.** El cliente lo describió como una pantalla para mirar. Si después
  quieren PDF, se agrega.
- **Seguimiento de varios productos a la vez.** Textual: *"ellos seleccionar qué producto quieren
  ver"*.

---

## 3. Cómo se resuelve "con quién"

Una vista, no una tabla nueva:

```sql
CREATE VIEW public.seguimiento_producto AS
SELECT m.id, m.producto_id, m.sucursal_id, m.created_at, m.tipo,
       m.cantidad, m.cantidad_anterior, m.cantidad_nueva, m.motivo, m.usuario_id,
       -- Con quién fue el movimiento y con qué papel. referencia_id es un uuid
       -- suelto sin FK: de qué tabla es lo dice el tipo del movimiento.
       -- El CASE cubre el enum ENTERO. Los que no tienen contraparte (ajustes,
       -- ingreso inicial) devuelven NULL a propósito, no por olvido.
       CASE m.tipo
         WHEN 'VENTA'                        THEN cli.razon_social
         WHEN 'ANULACION_VENTA'              THEN cli.razon_social
         WHEN 'DEVOLUCION'                   THEN cli.razon_social
         WHEN 'COMPRA'                       THEN prov_c.razon_social
         WHEN 'ANULACION_COMPRA'             THEN prov_c.razon_social
         WHEN 'INGRESO_MERCADERIA'           THEN prov_i.razon_social
         WHEN 'ANULACION_INGRESO_MERCADERIA' THEN prov_i.razon_social
         -- Las transferencias SÍ tienen referencia: el remito entre sucursales
         -- (20260721150000_r7_remito_aprueba_destino.sql:105).
         WHEN 'TRANSFERENCIA_OUT'            THEN 'Transferencia a otra sucursal'
         WHEN 'TRANSFERENCIA_IN'             THEN 'Transferencia desde otra sucursal'
         WHEN 'AJUSTE'                       THEN NULL   -- conteo físico o ajuste manual
         WHEN 'INGRESO_INICIAL'              THEN NULL
       END AS con_quien,
       CASE m.tipo
         WHEN 'VENTA'  THEN v.numero_comprobante
         ...
       END AS comprobante,
       v.condicion_venta          -- "si la gente se lo llevó como cuenta corriente"
  FROM public.stock_movimientos m
  LEFT JOIN public.ventas v               ON v.id  = m.referencia_id
  LEFT JOIN public.clientes cli           ON cli.id = v.cliente_id
  LEFT JOIN public.compras c              ON c.id  = m.referencia_id
  LEFT JOIN public.proveedores prov_c     ON prov_c.id = c.proveedor_id
  LEFT JOIN public.ingresos_mercaderia i  ON i.id  = m.referencia_id
  LEFT JOIN public.proveedores prov_i     ON prov_i.id = i.proveedor_id;
```

`condicion_venta` es lo que contesta *"si la gente se lo llevó como cuenta corriente"*, que el
cliente nombró específicamente.

**Por qué una vista y no columnas nuevas:** `referencia_id` ya está poblado en todo el historial. Si
se agregaran columnas desnormalizadas, habría que rellenarlas hacia atrás y mantenerlas en las seis
RPC que escriben movimientos — seis lugares nuevos donde olvidarse. La vista lee lo que ya hay.

**Los `LEFT JOIN` sobre `referencia_id` son seguros aunque no haya FK**: un uuid de venta no puede
coincidir con uno de compra. Y el `CASE` por tipo garantiza que sólo se muestre el join que
corresponde, aunque alguno matcheara por casualidad.

**Rendimiento:** hace falta un índice que hoy no existe.

```sql
CREATE INDEX IF NOT EXISTS idx_stock_mov_producto_fecha
  ON public.stock_movimientos (producto_id, created_at DESC);
```

Sin él, mirar un producto escanea toda la tabla de movimientos.

**RLS — con `security_invoker`, y no es un detalle.** Una vista normal corre con los permisos de su
**dueño**, así que una vista de `postgres` sobre tablas con RLS **la saltea**. Este repo ya lo sabe:
`stock_inventario` se creó con `WITH (security_invoker = true)`
(`20260724160000_conteo_fisico_stock.sql:116`) y deja `false` sólo donde quiere visibilidad global a
propósito (`20260718140000_seguridad_bajas_g6.sql:65`). Sin eso, esta vista sería una **fuga**: un
empleado vería los clientes y los comprobantes de la otra sucursal.

```sql
CREATE VIEW public.seguimiento_producto WITH (security_invoker = true) AS ...
```

Aun con eso, `stock_movimientos` tiene `USING (true)`, así que el empleado ve los movimientos de las
dos sucursales (el "con quién" sí queda filtrado, porque `ventas` filtra). **El filtro de sucursal
de la pantalla NO es seguridad**, es comodidad. Cambiar la RLS de `stock_movimientos` toca
Inventario, el conteo físico y los reportes: queda anotado como deuda, explícitamente, y no se hace
en este chunk.

---

## 4. La pantalla

Ruta `/productos/$id/seguimiento`, con un botón **Seguimiento** en cada fila de `/productos` (donde
ya están editar y eliminar). Entrar desde el producto es el flujo natural: *"ellos seleccionar qué
producto quieren ver"*.

```
Pincel N°10 · código 1234-5678
[ Sucursal ▾ ]  [ Últimos 12 meses ▾ ]

Stock hoy: 14        Entró: 60        Salió: 46

Fecha        Movimiento          Cant.   Saldo   Con quién           Comprobante
17/09/2025   Ingreso                +20      20   Quimex             R 0001-00001308
02/10/2025   Venta                   −4      16   PORTA HNOS SA      A 0003-00001066  cta cte
27/10/2025   Venta                   −2      14   Consumidor final   B 0003-00007342
```

- **Saldo** sale de `cantidad_nueva`, que se guarda por movimiento: no se recalcula sumando, que se
  desincronizaría ante cualquier ajuste. Pero la columna **nació nullable** y hay movimientos
  históricos sin snapshot (el repo tiene un diagnóstico que los cuenta:
  `supabase/snippets/diagnostico-stock-envase.sql:187`). Cuando falta, la celda dice **"—"** en vez
  de inventar un número. Antes de dar el chunk por terminado hay que **contar cuántos hay en
  producción** y decirlo.
- Las entradas en verde y las salidas en rojo, con signo. Es la lectura de un vistazo que pidieron.
- Los tres números de arriba (stock, entró, salió) son del período y la sucursal elegidos.
- Vacío honesto: *"Este producto no tiene movimientos en el período elegido."* Un producto sin
  movimientos es normal (el catálogo tiene 1104 y muchos nunca se vendieron).

**Paginado:** el listado usa `traerTodo` con el orden total que ya exige ese helper
(`created_at DESC, id`). Un producto que rota mucho puede pasar las 1000 filas de PostgREST, y este
repo ya se comió ese truncado en silencio dos veces.

---

## 5. Qué NO se toca

- `stock_movimientos`: ni columnas, ni RLS, ni las RPC que escriben ahí.
- El stock, las ventas, la caja. Es una pantalla de **sólo lectura**.

---

## 6. Verificación

**SQL (`scripts/test-seguimiento.sh`):**
- Un producto con venta, compra e ingreso muestra las tres, con el nombre del cliente y del
  proveedor que corresponde.
- El saldo de cada línea coincide con `cantidad_nueva`, y el último coincide con
  `stock_sucursal.cantidad`.
- Una venta a cuenta corriente aparece marcada como tal.
- Un movimiento de ajuste (sin `referencia_id`) no rompe la vista: sale con "con quién" vacío.
- El filtro por sucursal no mezcla depósitos.
- Un producto archivado sigue mostrando su historia.

**e2e con navegador:** entrar a un producto, ver sus movimientos, cambiar el período y que el
resumen acompañe.

**Siempre:** `bun run test`, `bun run typecheck`.

---

## 7. Orden de implementación

1. Migración: la vista + el índice.
2. La pantalla, con el filtro de sucursal y período.
3. El botón en `/productos`.
4. Tests SQL + e2e.

---

## 8. Hallazgos del review del spec con Codex

1. **BLOQUEANTE — la RLS de la vista estaba mal planteada.** Una vista normal corre con los permisos
   del dueño y **saltea RLS**: sin `security_invoker = true`, un empleado vería los clientes y
   comprobantes de la otra sucursal. Es una fuga, no una inconsistencia. El repo ya usa ese patrón
   en `stock_inventario`.
2. **El `CASE` no cubría el enum entero.** Faltaban `AJUSTE`, `TRANSFERENCIA_IN/OUT` e
   `INGRESO_INICIAL`, y las transferencias sí tienen referencia (el remito entre sucursales).
3. **`cantidad_nueva` no está garantizada históricamente**: nació nullable y hay movimientos viejos
   sin snapshot. → se muestra "—" y se cuenta cuántos hay en producción antes de cerrar.
4. **El filtro de sucursal de la pantalla no es seguridad**, porque `stock_movimientos` tiene
   `USING (true)`. Queda anotado como deuda explícita.
