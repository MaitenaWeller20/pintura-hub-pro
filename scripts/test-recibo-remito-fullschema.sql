\set ON_ERROR_STOP on

-- Correr solo contra la base Supabase descartable quimex-fullschema-20261103.
BEGIN;

CREATE FUNCTION pg_temp.assert_true(ok boolean, description text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FALLO: %', description; END IF;
  RAISE NOTICE 'OK: %', description;
END;
$$;

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  'aa110000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'fullschema-remito@test.local', 'x',
  now(), now(), now()
);
UPDATE public.profiles SET
  username = 'fullschema_remito', activo = true,
  sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ')
WHERE id = 'aa110000-0000-4000-8000-000000000001';
INSERT INTO public.user_roles(user_id, role)
VALUES ('aa110000-0000-4000-8000-000000000001', 'admin');
INSERT INTO public.profile_sucursales(profile_id, sucursal_id)
SELECT 'aa110000-0000-4000-8000-000000000001', id
FROM public.sucursales WHERE codigo = 'GENERALPAZ';
SELECT set_config('request.jwt.claims',
  '{"sub":"aa110000-0000-4000-8000-000000000001","role":"authenticated"}', true);

INSERT INTO public.clientes (
  id, razon_social, cuit_dni, tipo, condicion_cta_cte, limite_credito, activo
) VALUES (
  'bb110000-0000-4000-8000-000000000001',
  'CLIENTE PRUEBA REMITO FACTURABLE', '30505071316',
  'RESPONSABLE_INSCRIPTO', true, 1000000, true
);
INSERT INTO public.productos (
  id, codigo, nombre, precio_sin_iva, iva_porcentaje, activo
) VALUES (
  'cc110000-0000-4000-8000-000000000001',
  'TEST-REM-REC', 'Producto prueba remito facturable', 1000, 21, true
);
INSERT INTO public.stock_sucursal(producto_id, sucursal_id, cantidad)
SELECT 'cc110000-0000-4000-8000-000000000001', id, 100
FROM public.sucursales WHERE codigo = 'GENERALPAZ';
UPDATE public.settings
SET facturacion_receptor_v2_enabled = true, facturacion_legacy_writer_enabled = false
WHERE id = true;
INSERT INTO public.comprobante_secuencias(sucursal_id, tipo, ultimo_numero)
SELECT id, 'REMITO', 57 FROM public.sucursales WHERE codigo = 'GENERALPAZ'
ON CONFLICT (sucursal_id, tipo) DO UPDATE SET ultimo_numero = 57;

CREATE TEMP TABLE t_remito AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ'),
  'bb110000-0000-4000-8000-000000000001',
  'REMITO', 'CTA_CTE',
  '[{"producto_id":"cc110000-0000-4000-8000-000000000001","cantidad":10}]'::jsonb,
  '[]'::jsonb, 0, 'Prueba completa: remito a factura', NULL,
  '2026-10-14 16:55:00-03'::timestamptz, NULL,
  'dd110000-0000-4000-8000-000000000001'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND min(numero) = 'GPZ-REM-0058' FROM t_remito),
  'se creó el remito GPZ-REM-0058 en el esquema real'
);
CREATE TEMP TABLE t_cobro AS
SELECT * FROM public.registrar_cobranza(
  'bb110000-0000-4000-8000-000000000001',
  (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ'),
  5000, 'TRANSFERENCIA', '{"banco":"Banco de prueba","numero":"TEST-001"}'::jsonb,
  'Prueba de recibo sobre remito facturado'
);
CREATE TEMP TABLE t_antes AS
SELECT
  (SELECT count(*) FROM public.ventas) AS ventas,
  (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS cuenta_movimientos,
  (SELECT total_pagado FROM public.ventas WHERE id = (SELECT venta_id FROM t_remito)) AS total_pagado,
  (SELECT cantidad FROM public.stock_sucursal
   WHERE producto_id = 'cc110000-0000-4000-8000-000000000001'
     AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ')) AS stock;

CREATE TEMP TABLE t_imputacion AS
SELECT public.imputar_cobranza(
  (SELECT cobranza_id FROM t_cobro),
  jsonb_build_array(jsonb_build_object(
    'venta_id', (SELECT venta_id FROM t_remito), 'monto', 3000
  ))
) AS monto;
SELECT pg_temp.assert_true(
  (SELECT monto = 3000 FROM t_imputacion)
  AND (SELECT count(*) = 1 FROM public.cobranza_imputaciones i
       WHERE i.cobranza_id = (SELECT cobranza_id FROM t_cobro)
         AND i.venta_id = (SELECT venta_id FROM t_remito))
  AND (SELECT a.cuenta_movimientos = (SELECT count(*) FROM public.cuenta_corriente_movimientos)
       AND a.stock_movimientos = (SELECT count(*) FROM public.stock_movimientos)
       AND a.total_pagado = (SELECT total_pagado FROM public.ventas
                              WHERE id = (SELECT venta_id FROM t_remito))
       FROM t_antes a),
  'el cobro se imputó al remito sin alterar saldo, stock ni total_pagado'
);

CREATE TEMP TABLE t_conversion AS
SELECT public.convertir_remito_a_venta((SELECT venta_id FROM t_remito)) AS datos;
SELECT pg_temp.assert_true(
  (SELECT datos->>'venta_id' = (SELECT venta_id::text FROM t_remito)
     AND datos->>'numero_remito' = 'GPZ-REM-0058'
     AND datos->>'afip_estado' = 'SIN_FACTURAR' FROM t_conversion),
  'conversión devuelve la misma venta y deja el trámite fiscal pendiente'
);
SELECT pg_temp.assert_true(
  (SELECT v.numero_comprobante = 'GPZ-REM-0058'
      AND v.fecha = '2026-10-14 16:55:00-03'::timestamptz
      AND v.tipo_comprobante = 'VENTA'
      AND v.remito_facturado_at IS NOT NULL
      AND v.afip_estado = 'SIN_FACTURAR'
    FROM public.ventas v JOIN t_remito r ON r.venta_id = v.id),
  'número, fecha e identidad comercial se conservaron'
);
SELECT pg_temp.assert_true(
  (SELECT a.ventas = (SELECT count(*) FROM public.ventas)
      AND a.stock_movimientos = (SELECT count(*) FROM public.stock_movimientos)
      AND a.cuenta_movimientos = (SELECT count(*) FROM public.cuenta_corriente_movimientos)
      AND a.total_pagado = (SELECT total_pagado FROM public.ventas
                            WHERE id = (SELECT venta_id FROM t_remito))
      AND a.stock = (SELECT cantidad FROM public.stock_sucursal
        WHERE producto_id = 'cc110000-0000-4000-8000-000000000001'
          AND sucursal_id = (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ'))
    FROM t_antes a),
  'no duplicó venta, stock ni deuda'
);
SELECT pg_temp.assert_true(
  (SELECT public.convertir_remito_a_venta(venta_id)->>'venta_id' = venta_id::text
    FROM t_remito),
  'la segunda conversión devuelve la misma venta'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.cola_fiscal_lectura(
    'pendientes', 1, 25, NULL, NULL, NULL, NULL, NULL, NULL,
    (SELECT venta_id FROM t_remito)
  )),
  'la cola fiscal encuentra el remito convertido por ID aunque sea antiguo'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.cobranza_imputaciones i
   WHERE i.venta_id = (SELECT venta_id FROM t_remito)
     AND i.cobranza_id = (SELECT cobranza_id FROM t_cobro)),
  'la conversión conserva la imputación por el mismo venta_id'
);

CREATE TEMP TABLE t_cobro_imputado AS
SELECT * FROM public.registrar_cobranza_imputada(
  'bb110000-0000-4000-8000-000000000001',
  (SELECT id FROM public.sucursales WHERE codigo = 'GENERALPAZ'),
  1000, 'TRANSFERENCIA', '{}'::jsonb, NULL,
  jsonb_build_array(jsonb_build_object(
    'venta_id', (SELECT venta_id FROM t_remito), 'monto', 1000
  ))
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM t_cobro_imputado)
  AND (SELECT c.caja_sesion_id IS NOT NULL AND m.monto = 1000
       FROM public.cobranzas_cta_cte c
       JOIN public.cuenta_corriente_movimientos m ON m.cobranza_id = c.id
       WHERE c.id = (SELECT cobranza_id FROM t_cobro_imputado))
  AND (SELECT count(*) = 1 FROM public.cobranza_imputaciones
       WHERE cobranza_id = (SELECT cobranza_id FROM t_cobro_imputado))
  AND (SELECT total_pagado = 0 FROM public.ventas WHERE id = (SELECT venta_id FROM t_remito)),
  'el nuevo cobro se registró en caja y libro con imputación atómica sin tocar ventas.total_pagado'
);

CREATE TEMP TABLE t_despues_cobro AS
SELECT
  (SELECT count(*) FROM public.cobranzas_cta_cte) AS cobranzas,
  (SELECT count(*) FROM public.cuenta_corriente_movimientos) AS cuenta_movimientos,
  (SELECT count(*) FROM public.stock_movimientos) AS stock_movimientos;
CREATE TEMP TABLE t_recibo AS
SELECT public.emitir_recibo_cobranza((SELECT cobranza_id FROM t_cobro)) AS datos;
SELECT pg_temp.assert_true(
  (SELECT datos->>'numero' LIKE 'GPZ-RX-%'
      AND (datos#>>'{datos,monto}')::numeric = 5000
      AND (datos#>>'{datos,a_cuenta}')::numeric = 2000
      AND jsonb_array_length(datos#>'{datos,imputaciones}') = 1
      AND datos#>>'{datos,imputaciones,0,numero}' = 'GPZ-REM-0058'
      AND datos#>>'{datos,cliente,razon_social}' = 'CLIENTE PRUEBA REMITO FACTURABLE'
    FROM t_recibo),
  'recibo numerado con cliente, importe y sucursal correctos'
);
SELECT pg_temp.assert_true(
  (SELECT a.cobranzas = (SELECT count(*) FROM public.cobranzas_cta_cte)
      AND a.cuenta_movimientos = (SELECT count(*) FROM public.cuenta_corriente_movimientos)
      AND a.stock_movimientos = (SELECT count(*) FROM public.stock_movimientos)
    FROM t_despues_cobro a),
  'emitir recibo no creó cobro, deuda ni stock adicionales'
);
SELECT pg_temp.assert_true(
  (SELECT public.emitir_recibo_cobranza(cobranza_id) =
    (SELECT datos FROM t_recibo) FROM t_cobro),
  'reimpresión conserva número y snapshot'
);

CREATE TEMP TABLE t_recibo_imputado AS
SELECT public.emitir_recibo_cobranza((SELECT cobranza_id FROM t_cobro_imputado)) AS datos;
SELECT pg_temp.assert_true(
  (SELECT (datos#>>'{datos,a_cuenta}')::numeric = 0
      AND jsonb_array_length(datos#>'{datos,imputaciones}') = 1
      FROM t_recibo_imputado),
  'el segundo recibo lista la factura realmente imputada'
);
CREATE TEMP TABLE t_saldo_antes_anular AS
SELECT public.cc_saldo('bb110000-0000-4000-8000-000000000001') AS saldo;
SELECT public.anular_cobranza(
  (SELECT cobranza_id FROM t_cobro_imputado),
  'bb110000-0000-4000-8000-000000000001', 1000,
  'Prueba de anulación de cobro imputado'
);
SELECT pg_temp.assert_true(
  (SELECT public.cc_saldo('bb110000-0000-4000-8000-000000000001') = saldo + 1000
   FROM t_saldo_antes_anular)
  AND (SELECT i.monto = 1000 AND NOT i.activa
       FROM public.cc_imputaciones_cliente('bb110000-0000-4000-8000-000000000001') i
       WHERE i.cobranza_id = (SELECT cobranza_id FROM t_cobro_imputado))
  AND (SELECT r.datos->'datos' = (SELECT datos->'datos' FROM t_recibo_imputado)
       AND (r.datos->>'anulado')::boolean
       FROM (SELECT public.emitir_recibo_cobranza((SELECT cobranza_id FROM t_cobro_imputado)) AS datos) r),
  'anular el cobro libera su imputación, restaura saldo y preserva el snapshot del recibo'
);

SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  (SELECT public.convertir_remito_a_venta(v.id)->>'venta_id' = v.id::text
   FROM public.ventas v WHERE v.numero_comprobante = 'GPZ-REM-0058'),
  'el rol authenticated puede recuperar la conversión autorizada'
);
SELECT pg_temp.assert_true(
  (SELECT public.emitir_recibo_cobranza(c.id)->>'numero' LIKE 'GPZ-RX-%'
   FROM public.cobranzas_cta_cte c
   WHERE c.observaciones = 'Prueba de recibo sobre remito facturado'),
  'el rol authenticated puede reimprimir el recibo autorizado'
);
RESET ROLE;

CREATE TEMP TABLE t_claim AS
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_remito), 'RECLAMAR',
  'ee110000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'expected_version', (SELECT afip_version FROM public.ventas
                         WHERE id = (SELECT venta_id FROM t_remito)),
    'lease_segundos', 300
  )
);
SELECT pg_temp.assert_true(
  (SELECT afip_estado = 'EMITIENDO' AND afip_fase = 'PREFLIGHT'
   FROM t_claim),
  'la máquina fiscal acepta reclamar la misma venta sin crear movimientos'
);

ROLLBACK;
