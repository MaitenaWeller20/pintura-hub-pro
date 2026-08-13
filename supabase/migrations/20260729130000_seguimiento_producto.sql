-- ============================================================
-- SEGUIMIENTO DE UN PRODUCTO — la historia de cada artículo.
--
-- El pedido: "¿usted cuándo ingresó un pincel? ¿cuántas cantidades ingresaron? y
-- en el tiempo, ¿cómo se fue vendiendo? si la gente se lo llevó como cuenta
-- corriente. Quieren ver el avance de los productos".
--
-- La data ya está TODA en stock_movimientos. Lo que falta es responder CON QUIÉN
-- fue cada movimiento: `referencia_id` guarda el id de la venta / compra / remito
-- / ingreso, pero es un uuid suelto sin foreign key. De qué tabla es lo dice el
-- `tipo` del movimiento.
--
-- Ver docs/superpowers/specs/2026-07-29-seguimiento-producto-design.md
-- ============================================================

-- Sin este índice, mirar un producto escanea toda la tabla de movimientos.
CREATE INDEX IF NOT EXISTS idx_stock_mov_producto_fecha
  ON public.stock_movimientos (producto_id, created_at DESC);

-- ------------------------------------------------------------
-- La vista
--
-- `security_invoker = true` NO es opcional: una vista normal corre con los
-- permisos de su DUEÑO, así que una vista de `postgres` sobre tablas con RLS la
-- SALTEA. Sin esto, un empleado vería los clientes y los comprobantes de la otra
-- sucursal — es una fuga, no una inconsistencia. Mismo patrón que
-- stock_inventario (20260724160000_conteo_fisico_stock.sql:116).
--
-- OJO / deuda conocida: `stock_movimientos` tiene RLS `USING (true)`, así que el
-- empleado ve los MOVIMIENTOS de las dos sucursales (el "con quién" sí le queda
-- filtrado, porque `ventas` filtra). El filtro de sucursal de la pantalla es
-- comodidad, NO seguridad. Cambiar esa RLS toca Inventario, el conteo físico y
-- los reportes: no es de este chunk.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.seguimiento_producto;
CREATE VIEW public.seguimiento_producto WITH (security_invoker = true) AS
SELECT
  m.id,
  m.producto_id,
  m.sucursal_id,
  m.created_at,
  m.tipo,
  m.cantidad,
  m.cantidad_anterior,
  m.cantidad_nueva,
  m.motivo,
  m.usuario_id,

  -- Con quién fue. El CASE cubre el enum ENTERO: los que no tienen contraparte
  -- (ajustes, ingreso inicial) devuelven NULL a propósito, no por olvido.
  CASE m.tipo
    WHEN 'VENTA'                        THEN cli.razon_social
    WHEN 'ANULACION_VENTA'              THEN cli.razon_social
    WHEN 'DEVOLUCION'                   THEN cli.razon_social
    WHEN 'COMPRA'                       THEN prov_c.razon_social
    WHEN 'ANULACION_COMPRA'             THEN prov_c.razon_social
    WHEN 'INGRESO_MERCADERIA'           THEN prov_i.razon_social
    WHEN 'ANULACION_INGRESO_MERCADERIA' THEN prov_i.razon_social
    WHEN 'TRANSFERENCIA_OUT'            THEN 'Transferencia a otra sucursal'
    WHEN 'TRANSFERENCIA_IN'             THEN 'Transferencia desde otra sucursal'
    ELSE NULL   -- AJUSTE (conteo físico o manual), INGRESO_INICIAL
  END AS con_quien,

  -- Con qué papel.
  CASE m.tipo
    WHEN 'VENTA'                        THEN v.numero_comprobante
    WHEN 'ANULACION_VENTA'              THEN v.numero_comprobante
    WHEN 'DEVOLUCION'                   THEN v.numero_comprobante
    WHEN 'COMPRA'                       THEN c.numero_comprobante
    WHEN 'ANULACION_COMPRA'             THEN c.numero_comprobante
    WHEN 'INGRESO_MERCADERIA'           THEN i.numero_remito_proveedor
    WHEN 'ANULACION_INGRESO_MERCADERIA' THEN i.numero_remito_proveedor
    WHEN 'TRANSFERENCIA_OUT'            THEN r.numero
    WHEN 'TRANSFERENCIA_IN'             THEN r.numero
    ELSE NULL
  END AS comprobante,

  -- "Si la gente se lo llevó como cuenta corriente" — lo nombró el cliente.
  CASE WHEN m.tipo IN ('VENTA','ANULACION_VENTA','DEVOLUCION')
       THEN v.condicion_venta::text ELSE NULL END AS condicion_venta

FROM public.stock_movimientos m
-- Los LEFT JOIN sobre referencia_id son seguros aunque no haya FK: un uuid de
-- venta no puede coincidir con uno de compra. Y el CASE por tipo garantiza que
-- sólo se lea el join que corresponde.
LEFT JOIN public.ventas               v      ON v.id      = m.referencia_id
LEFT JOIN public.clientes             cli    ON cli.id    = v.cliente_id
LEFT JOIN public.compras              c      ON c.id      = m.referencia_id
LEFT JOIN public.proveedores          prov_c ON prov_c.id = c.proveedor_id
LEFT JOIN public.ingresos_mercaderia  i      ON i.id      = m.referencia_id
LEFT JOIN public.proveedores          prov_i ON prov_i.id = i.proveedor_id
LEFT JOIN public.remitos              r      ON r.id      = m.referencia_id;

GRANT SELECT ON public.seguimiento_producto TO authenticated;

COMMENT ON VIEW public.seguimiento_producto IS
  'La historia de cada producto: qué pasó, cuánto, con quién y con qué comprobante. Resuelve referencia_id (un uuid sin FK) según el tipo del movimiento. security_invoker: sin eso saltearía la RLS de ventas y clientes.';
