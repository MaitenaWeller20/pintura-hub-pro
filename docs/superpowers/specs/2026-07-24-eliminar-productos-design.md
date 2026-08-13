# Eliminación de productos (individual y masiva) — Diseño

**Fecha:** 2026-07-24
**Estado:** Diseño aprobado (revisado tras review de Codex del spec); pendiente implementación.

Feature para el sistema Quimex (pinturería, TanStack Start + React + Supabase/Postgres). Hoy los productos solo se dan de baja lógica editándolos (`activo = false`); no hay forma de eliminarlos, ni individual ni en lote. Este diseño agrega esa acción en `/productos` con una semántica explícita de tres desenlaces.

---

## 1. Principio rector: no se puede borrar historial, y `activo` está sobrecargado

`productos` está referenciado por muchas tablas. Las FK definen qué se puede borrar:

| Tabla | `ON DELETE` | Al borrar el producto |
|---|---|---|
| `stock_sucursal` | CASCADE | se borra el stock |
| `producto_codigos_proveedor` | CASCADE | se borran sus equivalencias |
| `stock_movimientos` (kardex) | NO ACTION | **bloquea** |
| `venta_items` | NO ACTION | **bloquea** |
| `compra_items` | NO ACTION | **bloquea** |
| `remito_items` (transferencias) | NO ACTION | **bloquea** |
| `ingreso_mercaderia_items` | NO ACTION | **bloquea** |

(La lista se verificó exhaustiva contra todas las migraciones: son las únicas 7 FK a `productos`.)

Dos consecuencias:

1. **Un producto con movimiento (venta, compra, transferencia, ingreso confirmado o kardex) no se puede borrar de la base** sin romper el pasado. Solo se borran de verdad los que nunca se usaron.
2. **`activo` ya significa dos cosas** y no alcanza para "eliminado": un producto nace **inactivo cuando todavía no tiene precio** (alta inline desde ingresos) y en ese estado **debe** seguir apareciendo en stock y poder recibir mercadería. Reusar `activo=false` para "eliminado" rompería ese flujo.

Por eso se agrega un flag **nuevo y separado**: `archivado`. `activo` = "vendible"; `archivado` = "sacado de las pantallas de trabajo".

---

## 2. Modelo de datos

```sql
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS archivado boolean NOT NULL DEFAULT false;
```

Índices para que el chequeo de historial en lote no escanee tablas grandes (faltan hoy):

```sql
CREATE INDEX IF NOT EXISTS idx_venta_items_producto      ON public.venta_items (producto_id);
CREATE INDEX IF NOT EXISTS idx_stock_mov_producto        ON public.stock_movimientos (producto_id);
CREATE INDEX IF NOT EXISTS idx_remito_items_producto     ON public.remito_items (producto_id);
```

(`compra_items` e `ingreso_mercaderia_items` ya tienen índice por `producto_id`.)

---

## 3. RPC `eliminar_productos(p_ids uuid[])`

SECURITY DEFINER, patrón del repo. Sirve para **individual** (array de 1) y **masivo** (array de N). Una transacción.

1. Valida `auth.uid()` y **admin** (`is_admin`). Escribir `productos` es solo-admin.
2. Por cada id, en orden **`FOR UPDATE` del producto → chequeos → acción** (el `FOR UPDATE` antes de los `EXISTS` cierra la carrera con una venta/ingreso concurrente: el `INSERT` hijo necesita `FOR KEY SHARE` sobre la fila del producto, que espera o falla contra nuestro lock).
3. Desenlace por producto:
   - **Referenciado por un ingreso en `BORRADOR`** (`EXISTS` en `ingreso_mercaderia_items` JOIN `ingresos_mercaderia` con `estado='BORRADOR'`) → **BLOQUEADO**: no se toca, se reporta con motivo. (Un borrador engancha `producto_id` antes de confirmar; no es historial real, pero su FK impediría el DELETE. Se pide resolver el borrador primero en vez de romperlo.)
   - Si no, **tiene historial real** (`EXISTS` en `venta_items`, `compra_items`, `remito_items`, `stock_movimientos`, o `ingreso_mercaderia_items` de un ingreso **confirmado**) **o tiene stock** (`EXISTS stock_sucursal con cantidad <> 0`) → **ARCHIVADO** (`UPDATE productos SET archivado = true`). No se puede borrar sin romper el pasado o tirar stock.
   - Si no (sin historial, sin stock, sin borrador) → **DELETE** real (arrastra en cascada `stock_sucursal` con cantidad 0 y `producto_codigos_proveedor`).
4. Devuelve resumen: `{ borrados: [...], archivados: [...], bloqueados: [{codigo, nombre, motivo}] }` (código/nombre por grupo, para el toast).

Nota sobre el **stock**: la importación de Excel y el seed cargan `stock_sucursal` **sin** dejar kardex, así que "sin historial" no implica "sin stock". Por eso el DELETE real exige además **stock cero**; si tiene stock, se archiva.

`REVOKE ALL` + `GRANT EXECUTE` a `authenticated` y `service_role`.

---

## 4. Visibilidad: dónde deja de verse un producto archivado

`archivado = true` lo saca de **todas las pantallas de trabajo**, manteniéndolo en el historial. Se agrega el filtro `archivado = false` (o `eq("archivado", false)`) en:

- **Ventas** — búsqueda de productos (además del `activo` que ya filtra).
- **`/stock`** — inventario (hoy no filtra nada; se le agrega `archivado=false`).
- **Transferencias (`/remitos`)** — selector de productos (hoy no filtra).
- **Match de ingresos** — `buscar_productos_similares` y el match por código exacto/aprendido excluyen archivados. **Importante:** siguen incluyendo los **inactivos NO archivados** (un producto inline sin precio tiene que poder recibir mercadería).
- **Dashboard de stock bajo** (`index.tsx`) — excluye archivados.

**No** se filtran los reportes históricos ni las pantallas que muestran el pasado (facturas, kardex, cuenta corriente): esas joinean por `producto_id` y deben seguir mostrando el producto archivado tal como fue.

En **`/productos`**: por defecto se ocultan los archivados; un toggle **"ver archivados"** los muestra (con pill "Archivado") para poder **restaurarlos** (una acción que hace `UPDATE archivado = false`). Los archivados no cuentan en el markup masivo ni en la selección por defecto.

---

## 5. Frontend en `/productos`

Reusa lo que ya existe: selección (`seleccion: Set`), checkboxes solo-admin, acción "Editar" por fila, barra de acciones (donde vive "Aplicar markup").

- **Por fila:** botón "Eliminar" (ícono tacho, ghost), solo-admin. Para un producto ya archivado, la acción de fila pasa a ser "Restaurar".
- **Masivo:** botón "Eliminar seleccionados (N)" en la barra, visible con selección.
- **Confirmación:** AlertDialog (patrón "anular" de ingresos/compras) que avisa: los que tengan historial o stock se **archivan** (se ocultan, no se borran; el pasado queda intacto), los que estén en un borrador de ingreso se **saltan**.
- **Resultado:** `toast` con el resumen de la RPC (p. ej. *"2 eliminados · 3 archivados · 1 en borrador (saltado)"*); limpiar selección; invalidar la query.
- **Toggle "ver archivados"** + acción "Restaurar" por fila.

La llamada va por un **server function** `eliminarProductos` / `restaurarProductos` (`createServerFn` + `requireSupabaseAuth`) que invoca la RPC, consistente con `aplicarMarkup`.

---

## 6. Permisos y seguridad

- **Solo admin**, validado en la RPC (`is_admin`), no solo escondiendo el botón.
- La RPC es la única vía de borrado/archivado; no se expone `DELETE` directo del cliente.
- No-admin que llame la RPC directo → `RAISE`.

---

## 7. Casos borde

- **Ya archivado** en la selección → no-op (o se puede restaurar desde el toggle).
- **Producto con stock pero sin movimientos** (importado por Excel) → se **archiva** (no se borra, no se tira stock).
- **En un borrador de ingreso** → **bloqueado**, con motivo en el resumen.
- **Selección mixta** → cada uno por separado; el resumen lo refleja.
- **IDs repetidos / inexistentes** → se ignoran; no rompen la operación.
- **Lista vacía** → no hace nada, resumen en ceros.

---

## 8. Verificación

- **e2e contra la base** (psql a la RPC):
  - Producto sin uso ni stock → **DELETE** (desaparece).
  - Producto con stock pero sin movimientos → **archivado** (no se borra).
  - Producto con una venta → **archivado**, la venta intacta.
  - Producto en un ingreso borrador → **bloqueado**.
  - Selección mixta → resumen correcto.
  - No-admin → rechazado.
  - Un producto archivado no aparece en `buscar_productos_similares`; uno inactivo-sin-precio sí.
- **typecheck** + tests en verde; regenerar `types.ts`.
- **Review con Codex** del diff antes de commitear.
- **Playwright** end-to-end: eliminar individual (uno sin uso → desaparece; uno con historial → "Archivado"), eliminar masivo con selección mixta viendo el toast, toggle "ver archivados" + restaurar.
- Deploy a prod (dry-run + push + Vercel) con autorización, y verificación.

---

## 9. No-objetivos (YAGNI)

- No se toca el bug preexistente de `crearRemito` no-transaccional (cabecera antes que ítems); la FK igual protege la integridad y está fuera de alcance de esta feature.
- No hay "papelera" con retención/purga: restaurar es `archivado=false`.
- No se borra historial nunca (ni ventas, ni kardex, ni ingresos).
- No se elimina en cascada "hacia arriba" (un producto con historial nunca fuerza el borrado de sus ventas).
