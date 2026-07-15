# Compras y Proveedores — Diseño

**Fecha:** 2026-07-15
**Estado:** Aprobado el diseño; pendiente revisión del spec.
**Revisado con:** Codex (crítica de arquitectura incorporada).

Feature nueva para el sistema Quimex (pinturería, TanStack Start + React + Supabase/Postgres). Hoy el stock sólo entra por ajuste manual, importación o transferencia entre sucursales; no existe forma de registrar la compra de mercadería a un proveedor ni de llevar la deuda con él. Este diseño agrega ese circuito.

---

## 1. Objetivos y no-objetivos

### Objetivos
- ABM de **proveedores** (razón social, CUIT con validación, condición IVA, cuenta corriente habilitada).
- Registrar **compras**: la factura del proveedor con sus ítems, que **suma stock** (con kardex) atómicamente.
- Llevar la **deuda con cada proveedor** (cuenta corriente de proveedor, saldo derivado de un libro) y los **pagos** al proveedor.
- Que los pagos a proveedor (salida de plata) se reflejen correctamente en el **arqueo de caja**.

### No-objetivos (YAGNI)
- **Órdenes de compra** formales (pedido → aprobación → recepción parcial). Se registra la compra ya recibida.
- **Actualizar el costo/precio** de los productos al comprar. La compra registra su costo unitario (que queda como historial en los ítems), pero no toca `productos.precio_fabrica` ni el precio de venta. El usuario ajusta precios aparte con el markup masivo existente.
- **Notas de crédito/débito de proveedor** como flujo completo: se deja el enum de tipo de comprobante preparado, pero el circuito de NC de proveedor es una etapa posterior. La corrección de un error de carga se hace con `anular_compra` (void interno), que es distinto.
- Multi-moneda, retenciones/percepciones impositivas complejas (sólo un campo simple de "percepciones/otros" para que el total cuadre con la factura).

---

## 2. Principio rector: compras NO es espejo literal de ventas

En una **venta**, Quimex **emite** el comprobante (numeración propia, correlativa, sin huecos; anular = emitir una NC propia). En una **compra**, Quimex **registra un comprobante externo** que emitió el proveedor. Consecuencias de diseño:

- El **número de comprobante** de una compra es el de la factura del proveedor (dato de entrada, no generado). Se valida único por `(proveedor, tipo, número)` para no cargar la misma factura dos veces.
- **Anular** una compra es una **corrección interna** (void de un error de carga), no la emisión de un documento. No genera una NC propia.
- Una **nota de crédito del proveedor** (cuando existe) es otro documento externo; se modela como un tipo de comprobante de compra con montos negativos, pero su flujo queda fuera de esta etapa.

---

## 3. Modelo de datos

### Enums nuevos
- `proveedor_cc_tipo`: `DEBITO` | `CREDITO` (igual que la cta cte de clientes).
- Se agrega `'COMPRA'` y `'ANULACION_COMPRA'` al enum existente `tipo_movimiento_stock`.
- El tipo de comprobante de compra se guarda como texto libre validado por CHECK (`FACTURA_A`, `FACTURA_B`, `FACTURA_C`, `NOTA_CREDITO`, `NOTA_DEBITO`, `REMITO`, `OTRO`) — no es el enum de ventas, porque es un documento del proveedor.

### `proveedores` (espejo de `clientes`)
`id, razon_social, cuit_dni (text), condicion_iva (tipo_cliente enum reusado), telefono, email, direccion, condicion_cta_cte (bool), activo (bool), created_at, updated_at`.
- Índice único parcial sobre el CUIT normalizado (activos), igual que clientes.
- Escritura directa (como clientes) + trigger guard para que un no-admin no habilite cta cte.

### `compras` (espejo parcial de `ventas`)
`id, proveedor_id, sucursal_id, usuario_id, tipo_comprobante (text+CHECK), numero_comprobante (text), fecha_comprobante (date), fecha_carga (timestamptz default now()), fecha_vencimiento (date null), subtotal_sin_iva, iva_total, percepciones, total, condicion (CONTADO|CTA_CTE), estado (ACTIVA|ANULADA), caja_sesion_id (uuid null), observaciones, created_at`.
- **UNIQUE parcial** `(proveedor_id, tipo_comprobante, numero_comprobante)` para estado='ACTIVA' — no cargar la misma factura dos veces.
- `caja_sesion_id` lo completa el trigger de estampado (sólo relevante para compras CONTADO).

### `compra_items` (espejo de `venta_items`)
`id, compra_id, producto_id, codigo (snapshot), descripcion (snapshot), cantidad, costo_unitario_sin_iva, iva_porcentaje, subtotal_sin_iva, iva_monto, subtotal_con_iva`.
- El snapshot de código/descripción/costo hace que los ítems sean el **historial de costos** del producto.

### `proveedor_cc_movimientos` (espejo de `cuenta_corriente_movimientos`)
`id, proveedor_id, sucursal_id, tipo (DEBITO|CREDITO), monto (>0), estado (CONFIRMADO|ANULADO), compra_id (UNIQUE null), pago_id (UNIQUE null), forma_pago (text null), descripcion, usuario_id, created_at`.
- **DEBITO** = compra a cuenta → aumenta lo que le debemos. **CREDITO** = pago → disminuye.
- Saldo = Σ DEBITO − Σ CREDITO sobre CONFIRMADOS = lo que le debemos. **Global por proveedor** (no por sucursal); cada movimiento igual registra su sucursal.
- Idempotencia por `compra_id` / `pago_id` UNIQUE.

### `proveedor_pagos` (espejo de `cobranzas_cta_cte`)
`id, proveedor_id, sucursal_id, usuario_id, fecha, monto (>0), forma_pago (text+CHECK, sin CTA_CTE), detalle (jsonb), caja_sesion_id (uuid null), created_at`.
- El monto es **siempre positivo**; la dirección (salida) la aplica `caja_esperado`.

---

## 4. RPCs transaccionales (SECURITY DEFINER, patrón `crear_venta`)

Todas: validan `auth.uid()`, validan que la sucursal sea la del usuario (o admin), toman `FOR UPDATE` donde corresponde, y **calculan** totales/usuario/caja_sesion_id en el servidor (nunca los aceptan del cliente).

- **`crear_compra(p_proveedor, p_sucursal, p_tipo_cbte, p_numero, p_fecha_cbte, p_fecha_vto, p_items, p_pagos, p_percepciones, p_condicion, p_observaciones)`** →
  1. Valida proveedor activo; si es CTA_CTE, que tenga `condicion_cta_cte`.
  2. Inserta `compras` + `compra_items` (con snapshot y totales calculados).
  3. **Suma stock**: `INSERT INTO stock_sucursal ... ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = stock_sucursal.cantidad + <comprada> RETURNING` (cubre fila inexistente + concurrencia). Kardex tipo `COMPRA`.
  4. Si **CTA_CTE**: DEBITO en el libro del proveedor.
  5. Si **CONTADO**: **exige caja abierta** (RAISE si no hay); registra los pagos en `proveedor_pagos` atados a la sesión. Rechaza `CTA_CTE` como forma de pago.
- **`anular_compra(p_compra_id)`** → corrección interna (admin):
  1. Marca la compra ANULADA.
  2. **Revierte stock**: valida `cantidad >= a_revertir` (RAISE si ya se vendió esa mercadería y quedaría negativo, salvo `permitir_stock_negativo`). Kardex `ANULACION_COMPRA`.
  3. Revierte la deuda (movimiento a ANULADO) o, si fue contado, revierte los pagos en caja (pago inverso atado a la sesión abierta hoy).
- **`registrar_pago_proveedor(p_proveedor, p_sucursal, p_monto, p_forma_pago, p_detalle)`** → **exige caja abierta**; inserta `proveedor_pagos` + CREDITO en el libro.
- **`anular_pago_proveedor(p_pago_id)`** → revierte un pago cargado por error (movimiento a ANULADO + reversa en caja).
- **`proveedor_saldo(p_proveedor)`** → saldo derivado (chequea sucursal/admin).

---

## 5. Impacto en el arqueo de caja

El arqueo hoy sólo tiene **entradas** (ventas, cobranzas). Con compras/proveedores aparecen **salidas** (pagar al proveedor). Cambios:

- **`caja_esperado(sesion)`** pasa a devolver, por forma de pago, **entradas, salidas y neto** (no sólo un total). Los `proveedor_pagos` y los pagos de compras contado de la sesión entran como **salida** (monto positivo en la tabla, restado en la función). Las ventas/cobranzas siguen como entrada.
- La pantalla **`arqueo.tsx`** muestra, por forma de pago, **Entradas / Salidas / Neto**, y el cierre cuenta contra el **neto esperado** (que puede ser negativo en una forma si se pagó más de lo que entró).
- El **trigger de estampado** de caja se reutiliza (la función genérica ya sirve si la tabla tiene `sucursal_id` + `caja_sesion_id`); se agrega el trigger BEFORE INSERT en `compras` y `proveedor_pagos`.

---

## 6. Seguridad

- **Tablas transaccionales** (`compras`, `compra_items`, `proveedor_cc_movimientos`, `proveedor_pagos`): sólo lectura para `authenticated`; escritura exclusiva por las RPC SECURITY DEFINER. Mismo criterio que ventas.
- **`proveedores`**: escritura directa (como clientes) + trigger guard para condiciones financieras (habilitar cta cte = admin).
- **RLS** por sucursal en las tablas que la tienen (`is_admin() OR sucursal_id = current_sucursal_id()`); la cta cte de proveedor es global por proveedor, legible por cualquier autenticado (como la de clientes).
- Las RPC validan sucursal internamente y no aceptan `usuario_id`, totales ni `caja_sesion_id` del cliente.
- `GRANT EXECUTE` a `authenticated` y `service_role`.

---

## 7. Frontend (reusa los componentes de `src/components/app/`)

- **`/proveedores`** — ABM, espejo de `clientes.tsx` (PageHeader, DataTable, diálogo con validación de CUIT).
- **`/compras`** — listado (DataTable + StatusPill de estado) + **`/compras/nueva`** (formulario espejo de `ventas.nueva.tsx`: proveedor, tipo/número/fecha del comprobante, ítems con costo, condición, formas de pago). Anular desde el listado (admin).
- **Cuenta corriente de proveedor** — **pestaña dentro de `/cuentas-corrientes`** (Tabs: Clientes | Proveedores), con saldo por proveedor, libro de movimientos y "Registrar pago".
- **Sidebar**: `/proveedores` y `/compras` bajo un grupo "Compras" (o dentro de "Catálogo"/"Administración" según encaje); regenerar `routeTree.gen.ts`.

---

## 8. Verificación (mismo estándar que el resto del sistema)

- **e2e contra la base** (curl a las RPC): crear compra contado (suma stock + sale de caja), crear compra a cuenta (sube la deuda), pagar a proveedor (baja la deuda + sale de caja), anular compra (revierte stock, con el chequeo de stock suficiente), doble carga de la misma factura (rechaza por unique), pago sin caja abierta (rechaza).
- **Arqueo**: abrir caja, comprar contado + pagar proveedor, cerrar y ver Entradas/Salidas/Neto y la diferencia correcta.
- **typecheck** + **tests** en verde; regenerar `types.ts`.
- **Revisión con Codex** del diff antes de commitear.
- **Verificación visual** de las pantallas nuevas en el navegador.
- Aplicar migraciones a producción (dry-run primero) + deploy, con autorización del usuario.

---

## 9. Orden de implementación (para el plan)

1. Migración: enums + tablas + índices + guards + RLS + grants.
2. RPCs: `crear_compra`, `registrar_pago_proveedor`, `proveedor_saldo`, `anular_compra`, `anular_pago_proveedor` + triggers de estampado.
3. `caja_esperado` v3 (entradas/salidas/neto) + ajuste de `arqueo.tsx`.
4. Frontend: proveedores → compras → pestaña cta cte proveedor → sidebar.
5. Verificación e2e + Codex + visual; commit; producción.
