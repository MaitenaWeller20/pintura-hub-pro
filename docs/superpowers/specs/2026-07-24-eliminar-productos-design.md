# Eliminación de productos (individual y masiva) — Diseño

**Fecha:** 2026-07-24
**Estado:** Diseño aprobado; pendiente revisión del spec.

Feature para el sistema Quimex (pinturería, TanStack Start + React + Supabase/Postgres). Hoy los productos solo se dan de baja lógica editándolos (`activo = false`); no hay forma de eliminarlos, ni individual ni en lote. Este diseño agrega una acción de eliminación en `/productos` que hace lo correcto según el caso.

---

## 1. Principio rector: no se puede borrar historial

`productos` está referenciado por muchas tablas transaccionales, y las FK definen qué se puede borrar:

| Tabla que referencia | `ON DELETE` | Efecto al borrar el producto |
|---|---|---|
| `stock_sucursal` | CASCADE | se borra el stock del producto |
| `producto_codigos_proveedor` | CASCADE | se borran sus equivalencias de proveedor |
| `stock_movimientos` (kardex) | RESTRICT | **bloquea** el borrado |
| `venta_items` | RESTRICT | **bloquea** el borrado |
| `compra_items` | RESTRICT | **bloquea** el borrado |
| `remito_items` (transferencias) | RESTRICT | **bloquea** el borrado |
| `ingreso_mercaderia_items` | RESTRICT | **bloquea** el borrado |

Conclusión: **un producto que alguna vez tuvo movimiento (venta, compra, transferencia, ingreso o cualquier ajuste de stock) no se puede borrar de la base** sin romper el pasado. Sólo se pueden borrar de verdad los que nunca se usaron (creados por error).

Por eso la eliminación es **híbrida**: borra de verdad lo que no tiene historial, y **desactiva** (`activo = false`) lo que sí lo tiene. Una sola acción "Eliminar" hace lo correcto según el caso; el usuario no tiene que saber de antemano cuál aplica.

---

## 2. RPC `eliminar_productos(p_ids uuid[])`

SECURITY DEFINER, patrón del resto de las RPC del repo. Una sola función sirve para **individual** (array de 1) y **masivo** (array de N).

1. Valida `auth.uid()` y **admin** (`is_admin`). Escribir `productos` es solo-admin (RLS `admin write prods`), así que el borrado también.
2. Toma los productos pedidos `FOR UPDATE`.
3. Por cada producto, detecta **historial** con `EXISTS` sobre: `venta_items`, `compra_items`, `remito_items`, `ingreso_mercaderia_items`, `stock_movimientos`.
   - **Con historial** → `UPDATE productos SET activo = false`. Si ya estaba inactivo, es no-op efectivo.
   - **Sin historial** → `DELETE FROM productos` (arrastra en cascada `stock_sucursal` y `producto_codigos_proveedor`).
4. Devuelve un resumen para que la UI avise: cantidad borrada, cantidad desactivada, y los nombres/códigos de cada grupo (p. ej. `{ borrados: [...], desactivados: [...] }`).

Todo en una transacción. Si un `DELETE` fallara igual por una FK no contemplada, se hace `RAISE` con el producto y no se aplica nada (atómico) — pero el chequeo previo de historial cubre las FK conocidas.

`REVOKE ALL` + `GRANT EXECUTE` a `authenticated` y `service_role`, como el resto.

---

## 3. Frontend en `/productos`

Reusa lo que ya existe: estado de selección (`seleccion: Set<string>`), checkboxes solo-admin, acción "Editar" por fila, y la barra de acciones donde vive "Aplicar markup".

- **Por fila:** botón "Eliminar" (ícono tacho, `variant=ghost`) al lado de "Editar", solo-admin.
- **Masivo:** botón "Eliminar seleccionados (N)" en la barra superior, al lado de "Aplicar markup", visible cuando hay selección.
- **Confirmación:** AlertDialog (mismo patrón que "anular" de ingresos/compras) que:
  - Lista cuántos productos se van a eliminar.
  - **Avisa** que los que tengan ventas/compras/movimientos se van a **desactivar** en vez de borrarse, y que eso no toca las facturas ni los reportes viejos.
- **Resultado:** `toast` con el resumen que devuelve la RPC (p. ej. *"2 eliminados · 3 desactivados (tenían historial)"*), limpiar la selección e invalidar la query de productos.

La llamada va por un **server function** `eliminarProductos` (`createServerFn` + `requireSupabaseAuth`) que invoca la RPC, para ser consistente con cómo se llama `aplicarMarkup` (aunque `productos` tiene escritura directa, la lógica de borrado con chequeo de historial vive mejor en la RPC).

---

## 4. Permisos y seguridad

- **Solo admin**, validado en la RPC (`is_admin`) — no alcanza con esconder el botón en la UI.
- La RPC es la única vía de borrado (no se expone `DELETE` directo desde el cliente).
- Un no-admin que llame la RPC directo recibe `RAISE`.

---

## 5. Casos borde

- **Producto ya inactivo, sin historial** → se borra (limpia inactivos viejos que nunca se usaron).
- **Producto ya inactivo, con historial** → sigue inactivo (no-op).
- **Producto con stock en mano pero sin movimientos** → se borra; su `stock_sucursal` cae en cascada. Es un caso raro (el stock normalmente viene de movimientos que dejarían historial).
- **Selección mixta** (algunos con historial, otros sin) → cada uno se resuelve por separado; el resumen lo refleja.
- **Lista vacía** → la RPC no hace nada y devuelve ceros.

---

## 6. Verificación

- **e2e contra la base** (curl/psql a la RPC):
  - Producto sin uso → se borra (desaparece de `productos`, y su `stock_sucursal` también).
  - Producto con una venta → queda `activo = false` y la venta (`venta_items`) sigue intacta.
  - Selección mixta → resumen correcto (borrados vs desactivados).
  - No-admin → rechazado.
- **typecheck** + tests en verde; regenerar `types.ts`.
- **Review con Codex** del diff antes de commitear.
- **Playwright** end-to-end: eliminar individual (uno sin historial → desaparece; uno con historial → queda "Inactivo"), y eliminar masivo con selección mixta, viendo el toast de resumen.
- Deploy a prod (dry-run + push + Vercel) con autorización, y verificación.

---

## 7. No-objetivos (YAGNI)

- No se toca `/stock` (queda de solo lectura; la gestión vive en `/productos`).
- No hay "papelera" ni "restaurar": reactivar un producto desactivado ya se hace editándolo (`activo = true`).
- No se borra historial nunca (ni ventas, ni kardex, ni ingresos).
- No se elimina en cascada "hacia arriba" (un producto con historial nunca fuerza el borrado de sus ventas).
