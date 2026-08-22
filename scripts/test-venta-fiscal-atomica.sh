#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %', p_message;
  END IF;
  RAISE NOTICE '✓ %', p_message;
END;
$$;

INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a4000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t4-venta-fiscal@test.local','x',now(),now(),now()
);

UPDATE public.profiles
   SET username='t4_venta_fiscal',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id='a4000000-0000-0000-0000-000000000001';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a4000000-0000-0000-0000-000000000001','admin');
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a4000000-0000-0000-0000-000000000001',id
  FROM public.sucursales ORDER BY numero LIMIT 1;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

INSERT INTO public.clientes (
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo
) VALUES (
  'b4000000-0000-0000-0000-000000000001','T4 CLIENTE FISCAL',
  'CONSUMIDOR_FINAL',true,99999999,true
);
INSERT INTO public.productos (
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo
) VALUES (
  'c4000000-0000-0000-0000-000000000001','T4-FISCAL',
  'PRODUCTO T4 FISCAL',1000,21,true
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c4000000-0000-0000-0000-000000000001',id,1000
  FROM public.sucursales ORDER BY numero LIMIT 1;

UPDATE public.caja_sesiones
   SET estado='CERRADA',cerrada_en=now()
 WHERE sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
   AND estado='ABIERTA';
INSERT INTO public.caja_sesiones(
  id,sucursal_id,estado,abierta_por,fondo_inicial
)
SELECT
  'd4000000-0000-0000-0000-000000000001',id,'ABIERTA',
  'a4000000-0000-0000-0000-000000000001',10000
FROM public.sucursales ORDER BY numero LIMIT 1;
INSERT INTO public.caja_movimientos(
  caja_sesion_id,tipo,forma_pago,monto,descripcion,usuario_id
) VALUES (
  'd4000000-0000-0000-0000-000000000001','INICIAL','EFECTIVO',10000,
  'Fondo T4','a4000000-0000-0000-0000-000000000001'
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

CREATE TEMP TABLE t_effects(
  label text PRIMARY KEY,
  ventas_count bigint,
  ventas_sum numeric,
  items_count bigint,
  items_sum numeric,
  pagos_count bigint,
  pagos_sum numeric,
  stock_mov_count bigint,
  stock_mov_sum numeric,
  stock_qty numeric,
  caja_mov_count bigint,
  caja_mov_sum numeric,
  caja_efectivo numeric,
  cc_count bigint,
  cc_sum numeric
);

CREATE OR REPLACE FUNCTION pg_temp.capture_effects(p_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO t_effects
  SELECT
    p_label,
    (SELECT count(*) FROM public.ventas),
    (SELECT COALESCE(sum(total),0) FROM public.ventas),
    (SELECT count(*) FROM public.venta_items),
    (SELECT COALESCE(sum(subtotal_con_iva),0) FROM public.venta_items),
    (SELECT count(*) FROM public.venta_pagos),
    (SELECT COALESCE(sum(monto),0) FROM public.venta_pagos),
    (SELECT count(*) FROM public.stock_movimientos),
    (SELECT COALESCE(sum(cantidad),0) FROM public.stock_movimientos),
    (SELECT cantidad FROM public.stock_sucursal
      WHERE producto_id='c4000000-0000-0000-0000-000000000001'
        AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),
    (SELECT count(*) FROM public.caja_movimientos),
    (SELECT COALESCE(sum(CASE WHEN tipo IN ('INICIAL','INGRESO') THEN monto ELSE -monto END),0)
       FROM public.caja_movimientos),
    public.efectivo_en_caja('d4000000-0000-0000-0000-000000000001'),
    (SELECT count(*) FROM public.cuenta_corriente_movimientos),
    (SELECT COALESCE(sum(CASE WHEN tipo='DEBITO' THEN monto ELSE -monto END),0)
       FROM public.cuenta_corriente_movimientos);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_effects_equal(
  p_before text,p_after text,p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT to_jsonb(e)-'label' INTO v_before FROM t_effects e WHERE label=p_before;
  SELECT to_jsonb(e)-'label' INTO v_after FROM t_effects e WHERE label=p_after;
  PERFORM pg_temp.assert_true(v_after IS NOT DISTINCT FROM v_before,p_message);
END;
$$;

SELECT pg_temp.capture_effects('base');

-- RED inicial: antes de la migración, next_comprobante_numero no reconoce VENTA.
CREATE TEMP TABLE t_sale AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001',
  'VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":2}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":1000}]'::jsonb,
  0,'T4-VENTA-PRINCIPAL',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000001'
);
SELECT pg_temp.capture_effects('created');

SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM t_sale),
  'crear VENTA devuelve una sola venta'
);
SELECT pg_temp.assert_true(
  (SELECT v.tipo_comprobante='VENTA'
       AND v.afip_estado='SIN_FACTURAR'
       AND v.numero_comprobante LIKE '%-VTA-%'
       AND v.afip_numero IS NULL
       AND v.cae IS NULL
     FROM public.ventas v JOIN t_sale s ON s.venta_id=v.id),
  'VENTA nace neutral, SIN_FACTURAR y sin identidad ARCA'
);
SELECT pg_temp.assert_true(
  (SELECT a.ventas_count=b.ventas_count+1
       AND a.items_count=b.items_count+1
       AND a.pagos_count=b.pagos_count+1
       AND a.stock_mov_count=b.stock_mov_count+1
       AND a.stock_qty=b.stock_qty-2
       AND a.pagos_sum=b.pagos_sum+1000
       AND a.caja_efectivo=b.caja_efectivo+1000
       AND a.cc_count=b.cc_count
     FROM t_effects a CROSS JOIN t_effects b
    WHERE a.label='created' AND b.label='base'),
  'crear VENTA escribe venta, item, pago, caja y stock exactamente una vez'
);

CREATE TEMP TABLE t_replay AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":2}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":1000}]'::jsonb,
  0,'T4-REPLAY-NO-DEBE-ESCRIBIR',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000001'
);
SELECT pg_temp.capture_effects('replayed');
SELECT pg_temp.assert_true(
  (SELECT r.venta_id=s.venta_id FROM t_replay r CROSS JOIN t_sale s),
  'la misma clave idempotente devuelve la misma venta'
);
SELECT pg_temp.assert_effects_equal(
  'created','replayed','el replay no duplica ningún efecto comercial'
);

-- Sólo una fila neutral versión 0 totalmente virgen se puede reparar.
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado_pago,
  observaciones,idempotency_key,afip_estado,afip_version
)
SELECT
  'f4000000-0000-0000-0000-000000000001',id,
  'b4000000-0000-0000-0000-000000000001',
  'a4000000-0000-0000-0000-000000000001','T4-VTA-LEGACY','VENTA',
  'CONTADO',100,21,121,121,'PAGADO','T4-LEGACY-NEUTRAL',
  'e4000000-0000-0000-0000-000000000002','PENDIENTE',0
FROM public.sucursales ORDER BY numero LIMIT 1;
SELECT venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":1210}]'::jsonb,
  0,NULL,NULL,NULL,NULL,'e4000000-0000-0000-0000-000000000002'
);
SELECT pg_temp.assert_true(
  (SELECT afip_estado='SIN_FACTURAR' AND afip_version=0
     FROM public.ventas WHERE id='f4000000-0000-0000-0000-000000000001'),
  'el fast path repara sólo el neutral legacy completamente virgen'
);

-- Un replay con claim activo debe bloquear la fila y devolverla sin resetearla.
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_sale),'RECLAMAR',
  'e4000000-0000-0000-0000-000000000010',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
CREATE TEMP TABLE t_emitting_before AS
SELECT afip_estado,afip_fase,afip_claim_token,afip_claimed_at,afip_version,
       afip_snapshot,afip_snapshot_hash,afip_numero
  FROM public.ventas WHERE id=(SELECT venta_id FROM t_sale);
SELECT pg_temp.capture_effects('before_emitting_replay');
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[]'::jsonb,'[]'::jsonb,0,NULL,NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000001'
);
SELECT pg_temp.capture_effects('after_emitting_replay');
SELECT pg_temp.assert_true(
  (SELECT jsonb_build_object(
            'afip_estado',v.afip_estado,'afip_fase',v.afip_fase,
            'afip_claim_token',v.afip_claim_token,'afip_claimed_at',v.afip_claimed_at,
            'afip_version',v.afip_version,'afip_snapshot',v.afip_snapshot,
            'afip_snapshot_hash',v.afip_snapshot_hash,'afip_numero',v.afip_numero
          ) IS NOT DISTINCT FROM jsonb_build_object(
            'afip_estado',b.afip_estado,'afip_fase',b.afip_fase,
            'afip_claim_token',b.afip_claim_token,'afip_claimed_at',b.afip_claimed_at,
            'afip_version',b.afip_version,'afip_snapshot',b.afip_snapshot,
            'afip_snapshot_hash',b.afip_snapshot_hash,'afip_numero',b.afip_numero
          )
     FROM public.ventas v CROSS JOIN t_emitting_before b
    WHERE v.id=(SELECT venta_id FROM t_sale)),
  'replay durante EMITIENDO preserva estado, token, versión y evidencia'
);
SELECT pg_temp.assert_effects_equal(
  'before_emitting_replay','after_emitting_replay',
  'replay durante EMITIENDO no duplica efectos comerciales'
);

-- El fallo inyectado al insertar el estado de cola revierte la transacción entera.
CREATE OR REPLACE FUNCTION pg_temp.fail_queue_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.observaciones='T4-FALLO-COLA' THEN
    IF NEW.afip_estado IS DISTINCT FROM 'SIN_FACTURAR' THEN
      RAISE EXCEPTION 'la inserción no intentó SIN_FACTURAR';
    END IF;
    RAISE EXCEPTION 'fallo inyectado de cola';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER t4_fail_queue_state
AFTER INSERT ON public.ventas
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_queue_state();
SELECT pg_temp.capture_effects('before_injected_failure');
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
      '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":3}]'::jsonb,
      '[{"forma_pago":"EFECTIVO","monto":1000}]'::jsonb,
      0,'T4-FALLO-COLA',NULL,NULL,NULL,
      'e4000000-0000-0000-0000-000000000003'
    );
    RAISE EXCEPTION 'la inyección no falló';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='la inyección no falló' OR SQLERRM NOT LIKE '%fallo inyectado de cola%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
DROP TRIGGER t4_fail_queue_state ON public.ventas;
DROP FUNCTION pg_temp.fail_queue_state();
SELECT pg_temp.capture_effects('after_injected_failure');
SELECT pg_temp.assert_effects_equal(
  'before_injected_failure','after_injected_failure',
  'un fallo al escribir cola revierte ventas, items, pagos, caja, stock y deuda'
);

-- Los dos gates cortan antes de cualquier efecto comercial.
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;
SELECT pg_temp.capture_effects('before_v2_gate');
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
      '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
      '[{"forma_pago":"EFECTIVO","monto":1210}]'::jsonb,
      0,'T4-GATE-V2',NULL,NULL,NULL,
      'e4000000-0000-0000-0000-000000000004'
    );
    RAISE EXCEPTION 'el gate v2 dejó escribir';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='el gate v2 dejó escribir' OR SQLERRM NOT LIKE '%receptor fiscal v2%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.capture_effects('after_v2_gate');
SELECT pg_temp.assert_effects_equal(
  'before_v2_gate','after_v2_gate','el gate v2 falla antes de efectos comerciales'
);
SELECT pg_temp.capture_effects('before_legacy_gate');
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.crear_venta(
      (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
      'b4000000-0000-0000-0000-000000000001','FACTURA_B','CONTADO',
      '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
      '[{"forma_pago":"EFECTIVO","monto":1210}]'::jsonb,
      0,'T4-GATE-LEGACY',NULL,NULL,NULL,
      'e4000000-0000-0000-0000-000000000005'
    );
    RAISE EXCEPTION 'el gate legacy dejó escribir';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='el gate legacy dejó escribir' OR SQLERRM NOT LIKE '%escritor fiscal legacy%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.capture_effects('after_legacy_gate');
SELECT pg_temp.assert_effects_equal(
  'before_legacy_gate','after_legacy_gate','el gate legacy falla antes de efectos comerciales'
);
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

-- Los documentos no fiscales conservan el estado NO_APLICA durante el corte.
CREATE TEMP TABLE t_remito AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','REMITO','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-REMITO-NO-APLICA',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000006'
);
SELECT pg_temp.assert_true(
  (SELECT v.afip_estado='NO_APLICA' AND v.afip_version=0
     FROM public.ventas v JOIN t_remito r ON r.venta_id=v.id),
  'remitos e internos permanecen fuera de la cola fiscal'
);

-- Presupuesto: una conversión neutral, una sola venta y efectos únicos.
CREATE TEMP TABLE t_budget AS
SELECT * FROM public.crear_presupuesto(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":2}]'::jsonb,
  'b4000000-0000-0000-0000-000000000001','T4 CLIENTE',NULL,'T4-PRESUPUESTO'
);
SELECT pg_temp.capture_effects('before_budget_conversion');
CREATE TEMP TABLE t_budget_sale AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_budget),
  'b4000000-0000-0000-0000-000000000001','CTA_CTE','[]'::jsonb,
  'e4000000-0000-0000-0000-000000000020'
);
SELECT pg_temp.capture_effects('after_budget_conversion');
SELECT pg_temp.assert_true(
  (SELECT v.tipo_comprobante='VENTA' AND v.afip_estado='SIN_FACTURAR'
       AND p.estado='CONVERTIDO' AND p.venta_id=v.id
       AND v.idempotency_key=
           pg_catalog.md5('presupuesto:'||p.id::text)::uuid
     FROM t_budget_sale bs
     JOIN public.ventas v ON v.id=bs.venta_id
     JOIN public.presupuestos p ON p.id=(SELECT presupuesto_id FROM t_budget)),
  'la conversión crea una venta neutral y marca el presupuesto una vez'
);
SELECT pg_temp.assert_true(
  (SELECT a.ventas_count=b.ventas_count+1
       AND a.items_count=b.items_count+1
       AND a.pagos_count=b.pagos_count
       AND a.stock_mov_count=b.stock_mov_count+1
       AND a.stock_qty=b.stock_qty-2
       AND a.cc_count=b.cc_count+1
     FROM t_effects a CROSS JOIN t_effects b
    WHERE a.label='after_budget_conversion' AND b.label='before_budget_conversion'),
  'la conversión mueve venta, item, stock y deuda una sola vez'
);
CREATE TEMP TABLE t_budget_replay AS
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_budget),
  'b4000000-0000-0000-0000-000000000001','CTA_CTE','[]'::jsonb,
  'e4000000-0000-0000-0000-000000000099'
);
SELECT pg_temp.capture_effects('after_budget_replay');
SELECT pg_temp.assert_true(
  (SELECT r.venta_id=s.venta_id FROM t_budget_replay r CROSS JOIN t_budget_sale s),
  'reintentar la conversión devuelve la misma venta'
);
SELECT pg_temp.assert_effects_equal(
  'after_budget_conversion','after_budget_replay',
  'reintentar la conversión no duplica efectos'
);

SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_budget_sale),'RECLAMAR',
  'e4000000-0000-0000-0000-000000000021',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_budget_sale),'ERROR_CORREGIBLE',
  'e4000000-0000-0000-0000-000000000021',
  '{"expected_version":1,"error_clase":"PREFLIGHT","error_codigo":"T4","error_fase":"PREFLIGHT","mensaje_mascarado":"fallo fiscal T4","liberar_identidad":true}'::jsonb
);
SELECT pg_temp.capture_effects('after_budget_fiscal_failure');
SELECT * FROM public.convertir_presupuesto_en_venta_neutral(
  (SELECT presupuesto_id FROM t_budget),
  'b4000000-0000-0000-0000-000000000001','CTA_CTE','[]'::jsonb,NULL
);
SELECT pg_temp.capture_effects('after_budget_failure_replay');
SELECT pg_temp.assert_true(
  (SELECT p.estado='CONVERTIDO' AND p.venta_id=(SELECT venta_id FROM t_budget_sale)
     FROM public.presupuestos p WHERE p.id=(SELECT presupuesto_id FROM t_budget)),
  'un fallo fiscal conserva el presupuesto CONVERTIDO y su venta'
);
SELECT pg_temp.assert_effects_equal(
  'after_budget_fiscal_failure','after_budget_failure_replay',
  'un fallo fiscal no duplica la conversión ni sus efectos'
);

-- Cobros posteriores: cuatro estados fiscales, misma evidencia congelada.
CREATE TEMP TABLE t_collection_sales(state text PRIMARY KEY,venta_id uuid);
INSERT INTO t_collection_sales
SELECT 'SIN_FACTURAR',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":100}]'::jsonb,0,'T4-COBRO-SIN',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000030');
INSERT INTO t_collection_sales
SELECT 'ERROR_CORREGIBLE',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":100}]'::jsonb,0,'T4-COBRO-ERROR',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000031');
INSERT INTO t_collection_sales
SELECT 'RECONCILIAR',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":100}]'::jsonb,0,'T4-COBRO-RECON',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000032');
INSERT INTO t_collection_sales
SELECT 'APROBADO',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[{"forma_pago":"EFECTIVO","monto":100}]'::jsonb,0,'T4-COBRO-OK',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000033');

UPDATE public.ventas v
   SET afip_estado='ERROR_CORREGIBLE',afip_version=1,
       afip_error='rechazo T4',afip_error_clase='ARCA',afip_error_codigo='T4'
  FROM t_collection_sales s
 WHERE s.state='ERROR_CORREGIBLE' AND v.id=s.venta_id;
UPDATE public.ventas v
   SET afip_estado='RECONCILIAR',afip_version=2,
       afip_emisor_cuit='30714199664',afip_punto_venta=995,afip_cbte_tipo=6,
       afip_numero=995001,afip_modo='PRODUCCION',afip_validez='PRODUCCION',
       afip_fecha_comprobante='2026-08-22',afip_imp_total=1210,
       afip_snapshot='{"version":2,"caso":"reconciliar"}',
       afip_snapshot_hash=repeat('b',64)
  FROM t_collection_sales s
 WHERE s.state='RECONCILIAR' AND v.id=s.venta_id;
UPDATE public.ventas v
   SET afip_estado='APROBADO',afip_version=2,
       afip_emisor_cuit='30714199664',afip_punto_venta=996,afip_cbte_tipo=6,
       afip_numero=996001,afip_modo='PRODUCCION',afip_validez='PRODUCCION',
       afip_fecha_comprobante='2026-08-22',afip_imp_total=1210,
       afip_snapshot='{"version":2,"caso":"aprobado"}',
       afip_snapshot_hash=repeat('c',64),cae='CAE-T4-COBRO',cae_vencimiento='2026-09-01'
  FROM t_collection_sales s
 WHERE s.state='APROBADO' AND v.id=s.venta_id;

-- Los replays de estados con evidencia tampoco pueden inicializarlos de nuevo.
CREATE TEMP TABLE t_replay_evidence_before AS
SELECT s.state,s.venta_id,
       jsonb_build_array(
         v.afip_estado,v.afip_version,v.afip_emisor_cuit,v.afip_punto_venta,
         v.afip_cbte_tipo,v.afip_numero,v.afip_modo,v.afip_validez,
         v.afip_fecha_comprobante,v.afip_imp_total,v.afip_snapshot,
         v.afip_snapshot_hash,v.cae,v.cae_vencimiento
       ) AS fiscal
  FROM t_collection_sales s JOIN public.ventas v ON v.id=s.venta_id
 WHERE s.state IN ('RECONCILIAR','APROBADO');
SELECT pg_temp.capture_effects('before_evidence_replays');
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[]'::jsonb,'[]'::jsonb,0,NULL,NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000032'
);
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CONTADO',
  '[]'::jsonb,'[]'::jsonb,0,NULL,NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000033'
);
SELECT pg_temp.capture_effects('after_evidence_replays');
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM t_replay_evidence_before b
    JOIN public.ventas v ON v.id=b.venta_id
    WHERE b.fiscal IS DISTINCT FROM jsonb_build_array(
      v.afip_estado,v.afip_version,v.afip_emisor_cuit,v.afip_punto_venta,
      v.afip_cbte_tipo,v.afip_numero,v.afip_modo,v.afip_validez,
      v.afip_fecha_comprobante,v.afip_imp_total,v.afip_snapshot,
      v.afip_snapshot_hash,v.cae,v.cae_vencimiento
    )
  ),
  'replays en RECONCILIAR y APROBADO preservan toda la evidencia fiscal'
);
SELECT pg_temp.assert_effects_equal(
  'before_evidence_replays','after_evidence_replays',
  'replays con evidencia fiscal no duplican efectos comerciales'
);

CREATE TEMP TABLE t_blocked AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-BLOQUEADA',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000034'
);
UPDATE public.ventas
   SET afip_estado='BLOQUEADO',afip_version=3,
       afip_error='evidencia incierta T4',afip_error_clase='SECUENCIA',
       afip_error_codigo='T4-BLOCK',afip_error_fase='PREFLIGHT',
       afip_ultimo_error_at=now()
 WHERE id=(SELECT venta_id FROM t_blocked);
CREATE TEMP TABLE t_blocked_before AS
SELECT afip_estado,afip_version,afip_error,afip_error_clase,afip_error_codigo,
       afip_error_fase,afip_ultimo_error_at
  FROM public.ventas WHERE id=(SELECT venta_id FROM t_blocked);
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[]'::jsonb,'[]'::jsonb,0,NULL,NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000034'
);
SELECT pg_temp.assert_true(
  (SELECT to_jsonb(v) IS NOT DISTINCT FROM to_jsonb(b)
     FROM (
       SELECT afip_estado,afip_version,afip_error,afip_error_clase,
              afip_error_codigo,afip_error_fase,afip_ultimo_error_at
         FROM public.ventas WHERE id=(SELECT venta_id FROM t_blocked)
     ) v CROSS JOIN t_blocked_before b),
  'replay en BLOQUEADO preserva versión y evidencia incierta'
);

CREATE TEMP TABLE t_fiscal_before AS
SELECT s.state,s.venta_id,
       jsonb_build_array(
         v.afip_snapshot,v.afip_snapshot_hash,v.afip_imp_total,
         v.afip_fecha_comprobante,v.afip_estado,v.cae,v.cae_vencimiento,
         v.afip_numero,v.afip_claim_token,v.afip_version
       ) AS fiscal,
       (SELECT jsonb_agg(to_jsonb(vp) ORDER BY vp.id)
          FROM public.venta_pagos vp
         WHERE vp.venta_id=v.id AND vp.cobro_idempotency_key IS NULL) AS pagos_originales,
       (SELECT count(*) FROM public.venta_items vi WHERE vi.venta_id=v.id) AS items
  FROM t_collection_sales s JOIN public.ventas v ON v.id=s.venta_id;
CREATE TEMP TABLE t_stock_before_collection AS
SELECT cantidad FROM public.stock_sucursal
 WHERE producto_id='c4000000-0000-0000-0000-000000000001'
   AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1);

SELECT * FROM public.cobrar_saldo_venta(
  (SELECT venta_id FROM t_collection_sales WHERE state='SIN_FACTURAR'),
  'EFECTIVO',100,'{}','e4000000-0000-0000-0000-000000000040');
SELECT * FROM public.cobrar_saldo_venta(
  (SELECT venta_id FROM t_collection_sales WHERE state='ERROR_CORREGIBLE'),
  'EFECTIVO',100,'{}','e4000000-0000-0000-0000-000000000041');
SELECT * FROM public.cobrar_saldo_venta(
  (SELECT venta_id FROM t_collection_sales WHERE state='RECONCILIAR'),
  'EFECTIVO',100,'{}','e4000000-0000-0000-0000-000000000042');
SELECT * FROM public.cobrar_saldo_venta(
  (SELECT venta_id FROM t_collection_sales WHERE state='APROBADO'),
  'EFECTIVO',100,'{}','e4000000-0000-0000-0000-000000000043');

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM t_fiscal_before b JOIN public.ventas v ON v.id=b.venta_id
     WHERE b.fiscal IS DISTINCT FROM jsonb_build_array(
       v.afip_snapshot,v.afip_snapshot_hash,v.afip_imp_total,
       v.afip_fecha_comprobante,v.afip_estado,v.cae,v.cae_vencimiento,
       v.afip_numero,v.afip_claim_token,v.afip_version
     )
  ),
  'cobrar saldo es fiscalmente inerte en SIN_FACTURAR, ERROR_CORREGIBLE, RECONCILIAR y APROBADO'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM t_fiscal_before b JOIN public.ventas v ON v.id=b.venta_id
     WHERE b.pagos_originales IS DISTINCT FROM (
       SELECT jsonb_agg(to_jsonb(vp) ORDER BY vp.id)
         FROM public.venta_pagos vp
        WHERE vp.venta_id=v.id AND vp.cobro_idempotency_key IS NULL
     )
       OR b.items<>(SELECT count(*) FROM public.venta_items vi WHERE vi.venta_id=v.id)
  )
  AND (SELECT cantidad FROM t_stock_before_collection)=
      (SELECT cantidad FROM public.stock_sucursal
        WHERE producto_id='c4000000-0000-0000-0000-000000000001'
          AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)),
  'cobrar agrega sólo el pago y no cambia pagos originales, items ni stock'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM t_collection_sales s
     WHERE (SELECT count(*) FROM public.venta_pagos vp WHERE vp.venta_id=s.venta_id)<>2
  ),
  'cada cobro posterior se registra exactamente una vez'
);

-- La venta parcial puede reclamarse después de cobrar; la CTA_CTE antes y después.
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_collection_sales WHERE state='SIN_FACTURAR'),
  'RECLAMAR','e4000000-0000-0000-0000-000000000044',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SELECT * FROM public.registrar_cobranza(
  'b4000000-0000-0000-0000-000000000001',
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  100,'EFECTIVO','{}','T4 cobro CTA_CTE después del fallo fiscal'
);
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT venta_id FROM t_budget_sale),'RECLAMAR',
  'e4000000-0000-0000-0000-000000000045',
  '{"expected_version":2,"lease_segundos":300}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT afip_estado='EMITIENDO' FROM public.ventas
    WHERE id=(SELECT venta_id FROM t_budget_sale)),
  'una venta CTA_CTE se puede volver a facturar después de una cobranza'
);

-- Anulación neutral sin CAE: CANCELAR interno, cero notas y reversión una vez.
CREATE TEMP TABLE t_cancel_neutral AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":2}]'::jsonb,
  '[]'::jsonb,0,'T4-CANCEL-NEUTRAL',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000050');
CREATE TEMP TABLE t_cancel_neutral_before AS
SELECT
  (SELECT cantidad FROM public.stock_sucursal
    WHERE producto_id='c4000000-0000-0000-0000-000000000001'
      AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)) AS stock,
  (SELECT count(*) FROM public.ventas) AS ventas_count;
SELECT * FROM public.anular_venta((SELECT venta_id FROM t_cancel_neutral));
SELECT pg_temp.assert_true(
  (SELECT v.estado='ANULADA' AND v.afip_estado='CANCELADO'
       AND v.venta_anulada_por IS NULL
     FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_cancel_neutral)),
  'anular una VENTA sin CAE cancela intención y venta sin crear nota'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.ventas)=(SELECT ventas_count FROM t_cancel_neutral_before)
  AND (SELECT count(*) FROM public.ventas
        WHERE afip_cbte_asoc_id=(SELECT venta_id FROM t_cancel_neutral))=0
  AND (SELECT cantidad FROM public.stock_sucursal
        WHERE producto_id='c4000000-0000-0000-0000-000000000001'
          AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1))
      =(SELECT stock+2 FROM t_cancel_neutral_before)
  AND (SELECT estado='ANULADO' FROM public.cuenta_corriente_movimientos
        WHERE venta_id=(SELECT venta_id FROM t_cancel_neutral)),
  'la anulación sin CAE revierte stock y deuda exactamente una vez'
);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_cancel_neutral));
    RAISE EXCEPTION 'la segunda anulación fue aceptada';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='la segunda anulación fue aceptada' OR SQLERRM NOT LIKE '%ya fue anulada%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

-- EMITIENDO y RECONCILIAR bloquean antes de cualquier reversión.
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_sale));
    RAISE EXCEPTION 'EMITIENDO se anuló';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='EMITIENDO se anuló' OR SQLERRM NOT LIKE '%EMITIENDO%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM public.anular_venta(
      (SELECT venta_id FROM t_collection_sales WHERE state='RECONCILIAR')
    );
    RAISE EXCEPTION 'RECONCILIAR se anuló';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='RECONCILIAR se anuló' OR SQLERRM NOT LIKE '%RECONCILIAR%' THEN RAISE; END IF;
  END;
END;
$$;

-- CAE productivo v2: una NC pendiente ligada al original y montos ARCA positivos por ABS.
CREATE TEMP TABLE t_approved_original AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-APPROVED-ORIGINAL',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000060');
UPDATE public.ventas
   SET afip_estado='APROBADO',afip_fase='PERSISTIDO',afip_version=2,
       afip_emisor_cuit='30714199664',afip_punto_venta=997,afip_cbte_tipo=6,
       afip_numero=997001,afip_modo='PRODUCCION',afip_simulado=false,
       afip_validez='PRODUCCION',afip_fecha_comprobante='2026-08-22',
       afip_imp_total=1210,
       afip_snapshot=jsonb_build_object(
         'version',2,'hash',repeat('d',64),'fechaComprobante','2026-08-22',
         'importeTotal','1210.00','items','[]'::jsonb,
         'receptor',jsonb_build_object(
           'origen','CLIENTE_COMERCIAL','razonSocial','T4 CLIENTE FISCAL',
           'tipoDocumento','DNI','numeroDocumento','30111222'
         ),
         'identidad',jsonb_build_object(
           'numero',997001,'emisorCuit','30714199664','puntoVenta',997,
           'cbteTipo',6,'modo','PRODUCCION','simulado',false
         )
       ),
       afip_snapshot_hash=repeat('d',64),cae='CAE-T4-PROD',
       cae_vencimiento='2026-09-01',afip_emitido_at=now()
 WHERE id=(SELECT venta_id FROM t_approved_original);

-- Una NC ya en curso consume el límite y bloquea la reversión total.
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,observaciones,afip_cbte_asoc_id,afip_estado,afip_version,
  afip_claim_token,afip_claimed_at,afip_snapshot,afip_snapshot_hash
)
SELECT
  'f4000000-0000-0000-0000-000000000060',v.sucursal_id,v.cliente_id,v.usuario_id,
  'T4-NC-EN-CURSO','NOTA_CREDITO','CONTADO',-82.64,-17.36,0,-100,0,
  'PENDIENTE','T4 NC en curso para límite',v.id,'EMITIENDO',2,
  'e4000000-0000-0000-0000-000000000063',now(),'{"version":2}'::jsonb,repeat('e',64)
FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_approved_original);
CREATE TEMP TABLE t_before_nc_limit AS
SELECT v.estado,v.venta_anulada_por,
       (SELECT cantidad FROM public.stock_sucursal
         WHERE producto_id='c4000000-0000-0000-0000-000000000001'
           AND sucursal_id=v.sucursal_id) AS stock,
       (SELECT count(*) FROM public.ventas n WHERE n.afip_cbte_asoc_id=v.id) AS notes
  FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_approved_original);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_approved_original));
    RAISE EXCEPTION 'el límite acumulado dejó crear otra NC';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='el límite acumulado dejó crear otra NC'
       OR SQLERRM NOT LIKE '%superarían el total%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT v.estado=b.estado
       AND v.venta_anulada_por IS NOT DISTINCT FROM b.venta_anulada_por
       AND (SELECT cantidad FROM public.stock_sucursal
             WHERE producto_id='c4000000-0000-0000-0000-000000000001'
               AND sucursal_id=v.sucursal_id)=b.stock
       AND (SELECT count(*) FROM public.ventas n WHERE n.afip_cbte_asoc_id=v.id)=b.notes
     FROM public.ventas v CROSS JOIN t_before_nc_limit b
    WHERE v.id=(SELECT venta_id FROM t_approved_original)),
  'el límite de NC acumuladas bloquea sin revertir efectos comerciales'
);
DELETE FROM public.ventas WHERE id='f4000000-0000-0000-0000-000000000060';

CREATE TEMP TABLE t_nc_result AS
SELECT * FROM public.anular_venta((SELECT venta_id FROM t_approved_original));
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM public.ventas
    WHERE afip_cbte_asoc_id=(SELECT venta_id FROM t_approved_original)
      AND tipo_comprobante='NOTA_CREDITO' AND afip_estado='SIN_FACTURAR'),
  'un CAE productivo crea exactamente una NC pendiente'
);
SELECT pg_temp.assert_true(
  (SELECT nc.total=-ABS(o.total)
       AND nc.subtotal_sin_iva=-ABS(o.subtotal_sin_iva)
       AND nc.iva_total=-ABS(o.iva_total)
       AND nc.afip_cbte_asoc_id=o.id
       AND o.afip_validez='PRODUCCION'
       AND o.afip_snapshot->'receptor' IS NOT NULL
     FROM public.ventas nc
     JOIN public.ventas o ON o.id=nc.afip_cbte_asoc_id
    WHERE nc.id=(SELECT nc_id FROM t_nc_result)),
  'la NC hereda identidad por el comprobante original y conserva montos comerciales negativos'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.venta_items vi
     WHERE vi.venta_id=(SELECT nc_id FROM t_nc_result)
       AND (ABS(vi.subtotal_sin_iva)<=0 OR ABS(vi.iva_monto)<=0 OR ABS(vi.subtotal_con_iva)<=0)
  ),
  'los importes de la NC tienen magnitud positiva para serializarlos a ARCA con ABS'
);

-- Homologación/simulación y legado incompleto jamás originan una NC productiva.
CREATE TEMP TABLE t_incompatible(kind text PRIMARY KEY,venta_id uuid);
INSERT INTO t_incompatible
SELECT 'HOMOLOGACION',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-HOMOLOGACION',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000061');
INSERT INTO t_incompatible
SELECT 'LEGACY',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-LEGACY-CAE',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000062');
UPDATE public.ventas v
   SET afip_estado='APROBADO',afip_version=0,afip_emisor_cuit='30714199664',
       afip_punto_venta=998,afip_cbte_tipo=6,afip_numero=998001,
       afip_modo='HOMOLOGACION',afip_simulado=false,afip_validez='HOMOLOGACION',
       cae='CAE-T4-HOMO'
  FROM t_incompatible i WHERE i.kind='HOMOLOGACION' AND v.id=i.venta_id;
UPDATE public.ventas v
   SET afip_estado='APROBADO',afip_version=0,afip_emisor_cuit='30714199664',
       afip_punto_venta=999,afip_cbte_tipo=6,afip_numero=999001,
       afip_modo='PRODUCCION',afip_simulado=false,afip_validez='PRODUCCION',
       afip_legacy_incompleto=true,cae='CAE-T4-LEGACY'
  FROM t_incompatible i WHERE i.kind='LEGACY' AND v.id=i.venta_id;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_incompatible WHERE kind='HOMOLOGACION'));
    RAISE EXCEPTION 'homologación originó NC productiva';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='homologación originó NC productiva' OR SQLERRM NOT LIKE '%producción%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_incompatible WHERE kind='LEGACY'));
    RAISE EXCEPTION 'legacy incompleto originó NC';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='legacy incompleto originó NC' OR SQLERRM NOT LIKE '%legado incompleto%' THEN RAISE; END IF;
  END;
END;
$$;

-- Contrato y mínimo privilegio.
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='crear_venta'
      AND pg_get_function_identity_arguments(p.oid)=
        'p_sucursal_id uuid, p_cliente_id uuid, p_tipo_comprobante tipo_comprobante, p_condicion_venta condicion_venta, p_items jsonb, p_pagos jsonb, p_percepciones numeric, p_observaciones text, p_nombre_obra text, p_fecha timestamp with time zone, p_cbte_asoc_id uuid, p_idempotency_key uuid'),
  'crear_venta conserva su firma exacta y sin overloads'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(p.prosecdef)
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='convertir_presupuesto_en_venta_neutral'
      AND pg_get_function_identity_arguments(p.oid)=
        'p_presupuesto_id uuid, p_cliente_id uuid, p_condicion_venta condicion_venta, p_pagos jsonb, p_idempotency_key uuid'),
  'la conversión neutral tiene un nombre y firma no ambiguos'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('public','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND NOT has_function_privilege('anon','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND has_function_privilege('authenticated','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute')
  AND has_function_privilege('service_role','public.convertir_presupuesto_en_venta_neutral(uuid,uuid,condicion_venta,jsonb,uuid)','execute'),
  'la conversión neutral revoca PUBLIC y otorga sólo authenticated/service_role'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('public','public.next_comprobante_numero(uuid,tipo_comprobante)','execute')
  AND NOT has_function_privilege('anon','public.next_comprobante_numero(uuid,tipo_comprobante)','execute')
  AND NOT has_function_privilege('authenticated','public.next_comprobante_numero(uuid,tipo_comprobante)','execute')
  AND NOT has_function_privilege('service_role','public.next_comprobante_numero(uuid,tipo_comprobante)','execute'),
  'next_comprobante_numero queda como helper interno sin roles API'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(p.prosecdef)
          AND bool_and(array_to_string(p.proconfig,',') LIKE 'search_path=%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='anular_venta'
      AND pg_get_function_identity_arguments(p.oid)='p_venta_id uuid'),
  'anular_venta conserva firma, SECURITY DEFINER y search_path fijado'
);

ROLLBACK;
SQL

# Prueba conductual del FOR UPDATE: una sesión cambia la fila bajo lock y el
# replay concurrente debe esperar para devolver el valor ya confirmado.
LOCK_DIR="$(mktemp -d)"
LOCK_PID=""
cleanup_concurrency_fixture() {
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    kill "$LOCK_PID" 2>/dev/null || true
    wait "$LOCK_PID" 2>/dev/null || true
  fi
  "${PSQL[@]}" >/dev/null 2>&1 <<'SQL' || true
BEGIN;
DELETE FROM public.ventas
 WHERE id='f4000000-0000-0000-0000-000000000101';
DELETE FROM public.profile_sucursales
 WHERE profile_id='a4000000-0000-0000-0000-000000000101';
DELETE FROM public.user_roles
 WHERE user_id='a4000000-0000-0000-0000-000000000101';
DELETE FROM public.clientes
 WHERE id='b4000000-0000-0000-0000-000000000101';
DELETE FROM public.profiles
 WHERE id='a4000000-0000-0000-0000-000000000101';
DELETE FROM auth.users
 WHERE id='a4000000-0000-0000-0000-000000000101';
COMMIT;
SQL
  rm -rf "$LOCK_DIR"
}
trap cleanup_concurrency_fixture EXIT

"${PSQL[@]}" <<'SQL'
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a4000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','t4-lock@test.local','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='t4_lock',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)
 WHERE id='a4000000-0000-0000-0000-000000000101';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a4000000-0000-0000-0000-000000000101','admin');
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a4000000-0000-0000-0000-000000000101',id
  FROM public.sucursales ORDER BY numero LIMIT 1;
INSERT INTO public.clientes(id,razon_social,tipo,condicion_cta_cte,limite_credito,activo)
VALUES (
  'b4000000-0000-0000-0000-000000000101','T4 LOCK CLIENTE',
  'CONSUMIDOR_FINAL',true,999999,true
);
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado_pago,
  observaciones,idempotency_key,afip_estado,afip_version
)
SELECT
  'f4000000-0000-0000-0000-000000000101',id,
  'b4000000-0000-0000-0000-000000000101',
  'a4000000-0000-0000-0000-000000000101','T4-VTA-LOCK','VENTA',
  'CTA_CTE',100,21,121,0,'PENDIENTE','T4-LOCK',
  'e4000000-0000-0000-0000-000000000101','SIN_FACTURAR',0
FROM public.sucursales ORDER BY numero LIMIT 1;
SQL

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/holder.out" 2>"$LOCK_DIR/holder.err" <<'SQL' &
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000101","role":"authenticated"}',
  true
);
UPDATE public.ventas
   SET condicion_venta='CONTADO'
 WHERE id='f4000000-0000-0000-0000-000000000101';
SELECT 'T4_LOCK_READY';
SELECT pg_sleep(3);
COMMIT;
SQL
LOCK_PID=$!

for _ in {1..100}; do
  if rg -q 'T4_LOCK_READY' "$LOCK_DIR/holder.out"; then
    break
  fi
  if ! kill -0 "$LOCK_PID" 2>/dev/null; then
    cat "$LOCK_DIR/holder.err" >&2
    echo "FALLO: la sesión que retenía el lock terminó antes de tiempo" >&2
    exit 1
  fi
  sleep 0.05
done
if ! rg -q 'T4_LOCK_READY' "$LOCK_DIR/holder.out"; then
  echo "FALLO: la sesión concurrente no adquirió el lock" >&2
  exit 1
fi

CONCURRENT_RESULT="$({
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq <<'SQL'
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000101","role":"authenticated"}',
  true
);
SELECT es_cta_cte FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000101','VENTA','CTA_CTE',
  '[]'::jsonb,'[]'::jsonb,0,NULL,NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000101'
);
COMMIT;
SQL
} | tail -n 1)"
wait "$LOCK_PID"
LOCK_PID=""
if [[ "$CONCURRENT_RESULT" != "f" ]]; then
  echo "FALLO: el replay concurrente no observó la fila confirmada bajo FOR UPDATE" >&2
  exit 1
fi
echo "✓ replay concurrente espera el lock y observa el estado comercial confirmado"

cleanup_concurrency_fixture
trap - EXIT

echo "✅ venta fiscal atómica: contrato completo en verde"
