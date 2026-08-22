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

-- FACTURA_A/B/C legacy sin CAE ni evidencia usa la misma acción CANCELAR y no
-- crea una venta-NC paralela.
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=false,
       facturacion_legacy_writer_enabled=true
 WHERE id=true;
INSERT INTO public.clientes(
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo
) VALUES (
  'b4000000-0000-0000-0000-000000000055','T4 CLIENTE RI LEGACY',
  'RESPONSABLE_INSCRIPTO',true,99999999,true
);
CREATE TEMP TABLE t_legacy_cancel(tipo public.tipo_comprobante PRIMARY KEY,venta_id uuid);
INSERT INTO t_legacy_cancel
SELECT 'FACTURA_A',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000055','FACTURA_A','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-CANCEL-LEGACY-A',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000055');
INSERT INTO t_legacy_cancel
SELECT 'FACTURA_B',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000055','FACTURA_B','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-CANCEL-LEGACY-B',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000056');
INSERT INTO t_legacy_cancel
SELECT 'FACTURA_C',venta_id FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000055','FACTURA_C','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-CANCEL-LEGACY-C',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000057');
CREATE TEMP TABLE t_legacy_cancel_before AS
SELECT
  (SELECT count(*) FROM public.ventas) AS ventas_count,
  (SELECT cantidad FROM public.stock_sucursal
    WHERE producto_id='c4000000-0000-0000-0000-000000000001'
      AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1)) AS stock;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM t_legacy_cancel ORDER BY tipo LOOP
    PERFORM * FROM public.anular_venta(r.venta_id);
  END LOOP;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.ventas)=(SELECT ventas_count FROM t_legacy_cancel_before)
  AND NOT EXISTS (
    SELECT 1 FROM t_legacy_cancel x JOIN public.ventas v ON v.id=x.venta_id
     WHERE v.estado<>'ANULADA' OR v.afip_estado<>'CANCELADO'
        OR v.venta_anulada_por IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM t_legacy_cancel x
    JOIN public.cuenta_corriente_movimientos c ON c.venta_id=x.venta_id
    WHERE c.estado<>'ANULADO'
  )
  AND (SELECT cantidad FROM public.stock_sucursal
        WHERE producto_id='c4000000-0000-0000-0000-000000000001'
          AND sucursal_id=(SELECT id FROM public.sucursales ORDER BY numero LIMIT 1))
      =(SELECT stock+3 FROM t_legacy_cancel_before),
  'FACTURA_A/B/C legacy vírgenes cancelan intención y comercio sin crear NC'
);

CREATE TEMP TABLE t_legacy_evidence AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1),
  'b4000000-0000-0000-0000-000000000055','FACTURA_B','CTA_CTE',
  '[{"producto_id":"c4000000-0000-0000-0000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'T4-CANCEL-LEGACY-EVIDENCIA',NULL,NULL,NULL,
  'e4000000-0000-0000-0000-000000000058');
UPDATE public.ventas SET afip_numero=123,afip_emisor_cuit='30714199664'
 WHERE id=(SELECT venta_id FROM t_legacy_evidence);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_legacy_evidence));
    RAISE EXCEPTION 'la factura legacy con evidencia se anuló';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='la factura legacy con evidencia se anuló'
       OR SQLERRM NOT LIKE '%evidencia fiscal%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT estado='ACTIVA' AND afip_estado='PENDIENTE' AND afip_numero=123
       AND afip_emisor_cuit='30714199664'
     FROM public.ventas WHERE id=(SELECT venta_id FROM t_legacy_evidence))
  AND NOT EXISTS (
    SELECT 1 FROM public.ventas
     WHERE venta_anulada_por=(SELECT venta_id FROM t_legacy_evidence)
        OR afip_cbte_asoc_id=(SELECT venta_id FROM t_legacy_evidence)
  ),
  'una factura legacy con número/evidencia queda intacta y requiere revisión'
);
UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

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
UPDATE public.ventas
   SET afip_snapshot_hash=public.fiscal_snapshot_hash(afip_snapshot),
       afip_snapshot=jsonb_set(
         afip_snapshot,'{hash}',to_jsonb(public.fiscal_snapshot_hash(afip_snapshot))
       )
 WHERE id=(SELECT venta_id FROM t_approved_original);

-- SQL NULL no puede satisfacer el requisito de fase PERSISTIDO. La anulación
-- debe fallar antes de crear la NC o revertir efectos comerciales.
UPDATE public.ventas SET afip_fase=NULL
 WHERE id=(SELECT venta_id FROM t_approved_original);
SELECT pg_temp.capture_effects('null-phase-anular-before');
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_approved_original));
    RAISE EXCEPTION 'T4_NULL_PHASE_ANULAR_ACEPTADA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='T4_NULL_PHASE_ANULAR_ACEPTADA'
       OR SQLERRM NOT LIKE '%identidad fiscal v2 completa%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.capture_effects('null-phase-anular-after');
SELECT pg_temp.assert_effects_equal(
  'null-phase-anular-before','null-phase-anular-after',
  'anular rechaza fase SQL NULL sin efectos comerciales'
);
SELECT pg_temp.assert_true(
  (SELECT v.estado='ACTIVA' AND v.venta_anulada_por IS NULL
       AND v.afip_estado='APROBADO' AND v.afip_fase IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.ventas n WHERE n.afip_cbte_asoc_id=v.id
       )
     FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_approved_original)),
  'anular deja intacto el original APROBADO con fase SQL NULL'
);
UPDATE public.ventas SET afip_fase='PERSISTIDO'
 WHERE id=(SELECT venta_id FROM t_approved_original);

-- Una NC legacy PENDIENTE también es una nota activa y bloquea una segunda.
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,percepciones,total,total_pagado,
  estado_pago,observaciones,afip_cbte_asoc_id,afip_estado,afip_version
)
SELECT
  'f4000000-0000-0000-0000-000000000059',v.sucursal_id,v.cliente_id,v.usuario_id,
  'T4-NC-LEGACY-PENDIENTE','NOTA_CREDITO','CONTADO',-82.64,-17.36,0,-100,0,
  'PENDIENTE','T4 NC legacy pendiente',v.id,'PENDIENTE',0
FROM public.ventas v WHERE v.id=(SELECT venta_id FROM t_approved_original);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.anular_venta((SELECT venta_id FROM t_approved_original));
    RAISE EXCEPTION 'una NC legacy PENDIENTE permitió crear otra';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='una NC legacy PENDIENTE permitió crear otra'
       OR SQLERRM NOT LIKE '%nota de crédito activa%' THEN RAISE; END IF;
  END;
END;
$$;
DELETE FROM public.ventas WHERE id='f4000000-0000-0000-0000-000000000059';

  -- Una NC parcial ya en curso consume el límite y bloquea la reversión total.
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

-- La frontera fiscal debe derivar la NC del original, no aceptar un snapshot
-- autoconsistente pero inventado por el caller.
SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT nc_id FROM t_nc_result),'RECLAMAR',
  'e4000000-0000-0000-0000-000000000064',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
CREATE OR REPLACE FUNCTION pg_temp.nc_reserva_payload(
  p_receptor jsonb DEFAULT NULL,
  p_modo text DEFAULT 'PRODUCCION',
  p_validez text DEFAULT 'PRODUCCION',
  p_cbte_tipo integer DEFAULT 8,
  p_importe text DEFAULT '1210.00',
  p_original_id text DEFAULT NULL,
  p_cbtes_asoc jsonb DEFAULT NULL,
  p_origen text DEFAULT 'COMPROBANTE_ORIGINAL'
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_original public.ventas%ROWTYPE;
  v_nc public.ventas%ROWTYPE;
  v_snapshot jsonb;
  v_hash text;
  v_max integer;
BEGIN
  SELECT v.* INTO v_nc
    FROM public.ventas v WHERE v.id=(SELECT nc_id FROM t_nc_result);
  SELECT v.* INTO v_original
    FROM public.ventas v WHERE v.id=v_nc.afip_cbte_asoc_id;
  SELECT COALESCE(max(v.afip_numero),0) INTO v_max
    FROM public.ventas v
   WHERE v.afip_emisor_cuit=v_original.afip_emisor_cuit
     AND v.afip_punto_venta=v_original.afip_punto_venta
     AND v.afip_cbte_tipo=p_cbte_tipo
     AND v.afip_modo=p_modo
     AND NOT v.afip_simulado
     AND v.afip_numero IS NOT NULL;
  v_snapshot := jsonb_build_object(
    'version',2,
    'hash','',
    'fechaComprobante','2026-08-22',
    'importeTotal',p_importe,
    'items','[]'::jsonb,
    'receptor',COALESCE(p_receptor,v_original.afip_snapshot->'receptor'),
    'identidad',jsonb_build_object(
      'numero',v_max+1,
      'emisorCuit',v_original.afip_emisor_cuit,
      'puntoVenta',v_original.afip_punto_venta,
      'cbteTipo',p_cbte_tipo,
      'modo',p_modo,
      'simulado',false
    ),
    'origen',p_origen,
    'comprobanteOriginalId',COALESCE(p_original_id,v_original.id::text),
    'cbtesAsoc',COALESCE(
      p_cbtes_asoc,
      jsonb_build_array(jsonb_build_object(
        'tipo',v_original.afip_cbte_tipo,
        'puntoVenta',v_original.afip_punto_venta,
        'numero',v_original.afip_numero,
        'fecha',v_original.afip_fecha_comprobante::text
      ))
    )
  );
  v_hash := public.fiscal_snapshot_hash(v_snapshot);
  v_snapshot := jsonb_set(v_snapshot,'{hash}',to_jsonb(v_hash));
  RETURN jsonb_build_object(
    'expected_version',1,
    'snapshot',v_snapshot,
    'snapshot_hash',v_hash,
    'numero_propuesto',v_max+1,
    'fecha_comprobante','2026-08-22',
    'emisor_cuit',v_original.afip_emisor_cuit,
    'punto_venta',v_original.afip_punto_venta,
    'cbte_tipo',p_cbte_tipo,
    'modo',p_modo,
    'simulado',false,
    'validez',p_validez,
    'ultimo_remoto',v_max,
    'ultimo_local_observado',v_max
  );
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.rehash_reserva_payload(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot jsonb := p_payload->'snapshot';
  v_hash text;
BEGIN
  v_hash := public.fiscal_snapshot_hash(v_snapshot);
  v_snapshot := jsonb_set(v_snapshot,'{hash}',to_jsonb(v_hash));
  RETURN jsonb_set(
    jsonb_set(p_payload,'{snapshot}',v_snapshot),
    '{snapshot_hash}',to_jsonb(v_hash)
  );
END;
$$;

CREATE TEMP TABLE t_nc_reservas_invalidas(caso text PRIMARY KEY,payload jsonb);
INSERT INTO t_nc_reservas_invalidas VALUES
  ('receptor distinto',pg_temp.nc_reserva_payload(
    '{"origen":"MANUAL","razonSocial":"OTRO","tipoDocumento":"CUIT","numeroDocumento":"30709999999"}'::jsonb
  )),
  ('modo y validez distintos',pg_temp.nc_reserva_payload(
    NULL,'HOMOLOGACION','HOMOLOGACION'
  )),
  ('cbteTipo no derivado',pg_temp.nc_reserva_payload(NULL,'PRODUCCION','PRODUCCION',3)),
  ('importe distinto',pg_temp.nc_reserva_payload(
    NULL,'PRODUCCION','PRODUCCION',8,'1.00'
  )),
  ('origen ambiguo',pg_temp.nc_reserva_payload(
    NULL,'PRODUCCION','PRODUCCION',8,'1210.00',NULL,NULL,'CLIENTE_COMERCIAL'
  )),
  ('asociación distinta',pg_temp.nc_reserva_payload(
    NULL,'PRODUCCION','PRODUCCION',8,'1210.00',
    '00000000-0000-0000-0000-000000000099'
  )),
  ('CbtesAsoc distinto',pg_temp.nc_reserva_payload(
    NULL,'PRODUCCION','PRODUCCION',8,'1210.00',NULL,
    '[{"tipo":6,"puntoVenta":997,"numero":1,"fecha":"2026-08-22"}]'::jsonb
  ));
INSERT INTO t_nc_reservas_invalidas
SELECT
  'asociación faltante',
  pg_temp.rehash_reserva_payload(
    jsonb_set(
      pg_temp.nc_reserva_payload(),'{snapshot}',
      (pg_temp.nc_reserva_payload()->'snapshot')-'comprobanteOriginalId'::text
    )
  );

CREATE TEMP TABLE t_nc_invalidas_aceptadas(caso text PRIMARY KEY);
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM t_nc_reservas_invalidas ORDER BY caso LOOP
    BEGIN
      PERFORM * FROM public.transicionar_emision_fiscal(
        (SELECT nc_id FROM t_nc_result),'RESERVAR',
        'e4000000-0000-0000-0000-000000000064',r.payload
      );
      RAISE EXCEPTION 'T4_NC_INVALIDA_ACEPTADA';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM='T4_NC_INVALIDA_ACEPTADA' THEN
        INSERT INTO t_nc_invalidas_aceptadas VALUES (r.caso);
      ELSIF SQLERRM NOT LIKE 'NC asociada:%' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END;
$$;
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM t_nc_invalidas_aceptadas),
  'RESERVAR rechaza receptor, identidad, tipo, monto y asociación no heredados'
);

-- Aunque el resto del original sea v2 productivo y completo, SQL NULL en fase
-- no equivale a PERSISTIDO. RESERVAR debe fallar sin consumir la reserva.
UPDATE public.ventas SET afip_fase=NULL
 WHERE id=(SELECT venta_id FROM t_approved_original);
SELECT pg_temp.capture_effects('null-phase-reservar-before');
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.transicionar_emision_fiscal(
      (SELECT nc_id FROM t_nc_result),'RESERVAR',
      'e4000000-0000-0000-0000-000000000064',
      pg_temp.nc_reserva_payload()
    );
    RAISE EXCEPTION 'T4_NULL_PHASE_RESERVAR_ACEPTADA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='T4_NULL_PHASE_RESERVAR_ACEPTADA'
       OR SQLERRM NOT LIKE 'NC asociada:%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
SELECT pg_temp.capture_effects('null-phase-reservar-after');
SELECT pg_temp.assert_effects_equal(
  'null-phase-reservar-before','null-phase-reservar-after',
  'RESERVAR rechaza fase SQL NULL sin efectos comerciales'
);
SELECT pg_temp.assert_true(
  (SELECT nc.afip_estado='EMITIENDO' AND nc.afip_fase='PREFLIGHT'
       AND nc.afip_version=1 AND nc.afip_numero IS NULL
       AND nc.afip_snapshot IS NULL AND o.afip_fase IS NULL
     FROM public.ventas nc
     JOIN public.ventas o ON o.id=nc.afip_cbte_asoc_id
    WHERE nc.id=(SELECT nc_id FROM t_nc_result)),
  'RESERVAR deja intactos original y NC cuando la fase es SQL NULL'
);
UPDATE public.ventas SET afip_fase='PERSISTIDO'
 WHERE id=(SELECT venta_id FROM t_approved_original);

SELECT * FROM public.transicionar_emision_fiscal(
  (SELECT nc_id FROM t_nc_result),'RESERVAR',
  'e4000000-0000-0000-0000-000000000064',
  pg_temp.nc_reserva_payload()
);
SELECT pg_temp.assert_true(
  (SELECT nc.afip_estado='EMITIENDO'
       AND nc.afip_fase='RESERVADO'
       AND nc.afip_emisor_cuit=o.afip_emisor_cuit
       AND nc.afip_punto_venta=o.afip_punto_venta
       AND nc.afip_cbte_tipo=8
       AND nc.afip_modo=o.afip_modo
       AND nc.afip_validez=o.afip_validez
       AND nc.afip_simulado=o.afip_simulado
       AND nc.afip_imp_total=ABS(nc.total)
       AND nc.afip_snapshot->'receptor'=o.afip_snapshot->'receptor'
       AND nc.afip_snapshot->>'origen'='COMPROBANTE_ORIGINAL'
       AND nc.afip_snapshot->>'comprobanteOriginalId'=o.id::text
     FROM public.ventas nc
     JOIN public.ventas o ON o.id=nc.afip_cbte_asoc_id
    WHERE nc.id=(SELECT nc_id FROM t_nc_result)),
  'RESERVAR acepta la NC con receptor, identidad y CbtesAsoc heredados'
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
    kill "$LOCK_PID"
    if ! wait "$LOCK_PID"; then
      : # terminar el holder por la señal del trap es el resultado esperado
    fi
    LOCK_PID=""
  fi
  "${PSQL[@]}" >/dev/null <<'SQL'
BEGIN;
DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id='f4000000-0000-0000-0000-000000000111';
DELETE FROM public.emision_fiscal_intentos
 WHERE venta_id IN (
   SELECT id FROM public.ventas
    WHERE afip_cbte_asoc_id='f4000000-0000-0000-0000-000000000112'
 );
UPDATE public.ventas SET venta_anulada_por=NULL
 WHERE id='f4000000-0000-0000-0000-000000000112';
DELETE FROM public.ventas
 WHERE afip_cbte_asoc_id='f4000000-0000-0000-0000-000000000112';
DELETE FROM public.ventas
 WHERE id='f4000000-0000-0000-0000-000000000112';
UPDATE public.ventas SET venta_anulada_por=NULL
 WHERE id='f4000000-0000-0000-0000-000000000110';
DELETE FROM public.ventas
 WHERE id='f4000000-0000-0000-0000-000000000111';
DELETE FROM public.ventas
 WHERE id='f4000000-0000-0000-0000-000000000110';
DELETE FROM public.ventas
 WHERE id='f4000000-0000-0000-0000-000000000101';
DELETE FROM public.caja_movimientos
 WHERE caja_sesion_id IN (
   SELECT id FROM public.caja_sesiones
    WHERE abierta_por='a4000000-0000-0000-0000-000000000101'
 );
DELETE FROM public.caja_sesiones
 WHERE abierta_por='a4000000-0000-0000-0000-000000000101';
UPDATE public.profiles
   SET activo=false,sucursal_id=NULL
 WHERE id='a4000000-0000-0000-0000-000000000101';
DELETE FROM public.profile_sucursales
 WHERE profile_id='a4000000-0000-0000-0000-000000000101';
DELETE FROM public.user_roles
 WHERE user_id='a4000000-0000-0000-0000-000000000101';
DELETE FROM public.clientes
 WHERE id='b4000000-0000-0000-0000-000000000101';
DELETE FROM auth.users
 WHERE id='a4000000-0000-0000-0000-000000000101';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
     WHERE id='a4000000-0000-0000-0000-000000000101'
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id='a4000000-0000-0000-0000-000000000101'
  ) OR EXISTS (
    SELECT 1 FROM public.clientes
     WHERE id='b4000000-0000-0000-0000-000000000101'
  ) OR EXISTS (
    SELECT 1 FROM public.ventas
     WHERE id IN (
       'f4000000-0000-0000-0000-000000000101',
       'f4000000-0000-0000-0000-000000000110',
       'f4000000-0000-0000-0000-000000000111',
       'f4000000-0000-0000-0000-000000000112'
     )
  ) THEN
    RAISE EXCEPTION 'la limpieza concurrente dejó filas del fixture';
  END IF;
END;
$$;
COMMIT;
SQL
  rm -rf -- "$LOCK_DIR"
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

# Dos anulaciones reales compiten por el mismo original. La segunda debe
# esperar el lock, observar ANULADA y no crear una segunda NC.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado_pago,
  afip_estado,afip_fase,afip_version,afip_emisor_cuit,afip_punto_venta,
  afip_cbte_tipo,afip_numero,afip_modo,afip_simulado,afip_validez,
  afip_fecha_comprobante,afip_imp_total,afip_snapshot,afip_snapshot_hash,
  cae,cae_vencimiento,afip_emitido_at
)
SELECT
  'f4000000-0000-0000-0000-000000000112',id,
  'b4000000-0000-0000-0000-000000000101',
  'a4000000-0000-0000-0000-000000000101','T4-ORIGINAL-ANULAR-RACE','VENTA',
  'CTA_CTE',100,21,121,0,'PENDIENTE','APROBADO','PERSISTIDO',2,
  '30714199664',992,6,992001,'PRODUCCION',false,'PRODUCCION','2026-08-22',121,
  jsonb_build_object(
    'version',2,'hash',repeat('a',64),'fechaComprobante','2026-08-22',
    'importeTotal','121.00','items','[]'::jsonb,
    'receptor',jsonb_build_object(
      'origen','CLIENTE_COMERCIAL','razonSocial','T4 LOCK CLIENTE',
      'tipoDocumento','DNI','numeroDocumento','30111222'
    ),
    'identidad',jsonb_build_object(
      'numero',992001,'emisorCuit','30714199664','puntoVenta',992,
      'cbteTipo',6,'modo','PRODUCCION','simulado',false
    )
  ),repeat('a',64),'CAE-T4-ANULAR-RACE','2026-09-01',now()
FROM public.sucursales ORDER BY numero LIMIT 1;
UPDATE public.ventas
   SET afip_snapshot_hash=public.fiscal_snapshot_hash(afip_snapshot),
       afip_snapshot=jsonb_set(
         afip_snapshot,'{hash}',to_jsonb(public.fiscal_snapshot_hash(afip_snapshot))
       )
 WHERE id='f4000000-0000-0000-0000-000000000112';
SQL

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/anular-holder.out" 2>"$LOCK_DIR/anular-holder.err" <<'SQL' &
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000101","role":"authenticated"}',
  true
);
SELECT * FROM public.anular_venta('f4000000-0000-0000-0000-000000000112');
SELECT 'T4_ANULAR_LOCK_READY';
SELECT pg_sleep(3);
COMMIT;
SQL
LOCK_PID=$!
for _ in {1..100}; do
  if rg -q 'T4_ANULAR_LOCK_READY' "$LOCK_DIR/anular-holder.out"; then
    break
  fi
  if ! kill -0 "$LOCK_PID" 2>/dev/null; then
    cat "$LOCK_DIR/anular-holder.err" >&2
    echo "FALLO: la primera anulación terminó antes de adquirir el lock" >&2
    exit 1
  fi
  sleep 0.05
done
if ! rg -q 'T4_ANULAR_LOCK_READY' "$LOCK_DIR/anular-holder.out"; then
  echo "FALLO: la primera anulación no retuvo el lock del original" >&2
  exit 1
fi

if ANULAR_RACE_OUTPUT="$({
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq <<'SQL'
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-0000-0000-000000000101","role":"authenticated"}',
  false
);
SELECT * FROM public.anular_venta('f4000000-0000-0000-0000-000000000112');
SQL
} 2>&1)"; then
  echo "FALLO: dos anulaciones concurrentes confirmaron resultado" >&2
  exit 1
fi
wait "$LOCK_PID"
LOCK_PID=""
if [[ "$ANULAR_RACE_OUTPUT" != *"La venta ya fue anulada"* ]]; then
  echo "$ANULAR_RACE_OUTPUT" >&2
  echo "FALLO: la segunda anulación falló por un motivo inesperado" >&2
  exit 1
fi
ANULAR_RACE_STATE="$(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq <<'SQL'
SELECT o.estado||'|'||count(n.id)::text||'|'||
       count(n.id) FILTER (WHERE n.id=o.venta_anulada_por)::text
  FROM public.ventas o
  LEFT JOIN public.ventas n ON n.afip_cbte_asoc_id=o.id
 WHERE o.id='f4000000-0000-0000-0000-000000000112'
 GROUP BY o.id,o.estado;
SQL
)"
if [[ "$ANULAR_RACE_STATE" != "ANULADA|1|1" ]]; then
  echo "FALLO: dos anulaciones dejaron resultados incompatibles: $ANULAR_RACE_STATE" >&2
  exit 1
fi
echo "✓ dos anulaciones concurrentes crean exactamente una NC"

# Una reserva de NC comparte el lock del original. Mientras otra sesión invalida
# el vínculo de anulación, la reserva debe esperar y luego fallar cerrada.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado_pago,
  estado,venta_anulada_por,afip_estado,afip_fase,afip_version,
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,
  afip_simulado,afip_validez,afip_fecha_comprobante,afip_imp_total,
  afip_snapshot,afip_snapshot_hash,cae,cae_vencimiento,afip_emitido_at
)
SELECT
  'f4000000-0000-0000-0000-000000000110',id,
  'b4000000-0000-0000-0000-000000000101',
  'a4000000-0000-0000-0000-000000000101','T4-ORIGINAL-RACE','VENTA',
  'CTA_CTE',100,21,121,0,'PENDIENTE','ANULADA',NULL,
  'APROBADO','PERSISTIDO',2,'30714199664',991,6,991001,'PRODUCCION',
  false,'PRODUCCION','2026-08-22',121,
  jsonb_build_object(
    'version',2,'hash',repeat('f',64),'fechaComprobante','2026-08-22',
    'importeTotal','121.00','items','[]'::jsonb,
    'receptor',jsonb_build_object(
      'origen','CLIENTE_COMERCIAL','razonSocial','T4 LOCK CLIENTE',
      'tipoDocumento','DNI','numeroDocumento','30111222'
    ),
    'identidad',jsonb_build_object(
      'numero',991001,'emisorCuit','30714199664','puntoVenta',991,
      'cbteTipo',6,'modo','PRODUCCION','simulado',false
    )
  ),repeat('f',64),'CAE-T4-RACE','2026-09-01',now()
FROM public.sucursales ORDER BY numero LIMIT 1;
INSERT INTO public.ventas(
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  condicion_venta,subtotal_sin_iva,iva_total,total,total_pagado,estado_pago,
  estado,afip_cbte_asoc_id,afip_estado,afip_version
)
SELECT
  'f4000000-0000-0000-0000-000000000111',o.sucursal_id,o.cliente_id,o.usuario_id,
  'T4-NC-RACE','NOTA_CREDITO','CONTADO',-100,-21,-121,0,'PENDIENTE',
  'ACTIVA',o.id,'SIN_FACTURAR',0
FROM public.ventas o WHERE o.id='f4000000-0000-0000-0000-000000000110';
UPDATE public.ventas
   SET venta_anulada_por='f4000000-0000-0000-0000-000000000111',
       afip_snapshot_hash=public.fiscal_snapshot_hash(afip_snapshot),
       afip_snapshot=jsonb_set(
         afip_snapshot,'{hash}',to_jsonb(public.fiscal_snapshot_hash(afip_snapshot))
       )
 WHERE id='f4000000-0000-0000-0000-000000000110';
SELECT * FROM public.transicionar_emision_fiscal(
  'f4000000-0000-0000-0000-000000000111','RECLAMAR',
  'e4000000-0000-0000-0000-000000000111',
  '{"expected_version":0,"lease_segundos":300}'::jsonb
);
SQL

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq \
  >"$LOCK_DIR/nc-holder.out" 2>"$LOCK_DIR/nc-holder.err" <<'SQL' &
BEGIN;
UPDATE public.ventas SET venta_anulada_por=NULL
 WHERE id='f4000000-0000-0000-0000-000000000110';
SELECT 'T4_NC_ORIGINAL_LOCK_READY';
SELECT pg_sleep(3);
COMMIT;
SQL
LOCK_PID=$!
for _ in {1..100}; do
  if rg -q 'T4_NC_ORIGINAL_LOCK_READY' "$LOCK_DIR/nc-holder.out"; then
    break
  fi
  if ! kill -0 "$LOCK_PID" 2>/dev/null; then
    cat "$LOCK_DIR/nc-holder.err" >&2
    echo "FALLO: la sesión del original terminó antes de adquirir el lock" >&2
    exit 1
  fi
  sleep 0.05
done
if ! rg -q 'T4_NC_ORIGINAL_LOCK_READY' "$LOCK_DIR/nc-holder.out"; then
  echo "FALLO: la sesión no bloqueó el original de la NC" >&2
  exit 1
fi

if NC_RACE_OUTPUT="$({
  docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq <<'SQL'
WITH base AS (
  SELECT jsonb_build_object(
    'version',2,'hash','','fechaComprobante','2026-08-22',
    'importeTotal','121.00','items','[]'::jsonb,
    'receptor',o.afip_snapshot->'receptor',
    'identidad',jsonb_build_object(
      'numero',1,'emisorCuit',o.afip_emisor_cuit,'puntoVenta',o.afip_punto_venta,
      'cbteTipo',8,'modo',o.afip_modo,'simulado',o.afip_simulado
    ),
    'origen','COMPROBANTE_ORIGINAL','comprobanteOriginalId',o.id::text,
    'cbtesAsoc',jsonb_build_array(jsonb_build_object(
      'tipo',o.afip_cbte_tipo,'puntoVenta',o.afip_punto_venta,
      'numero',o.afip_numero,'fecha',o.afip_fecha_comprobante::text
    ))
  ) AS snapshot
  FROM public.ventas o WHERE o.id='f4000000-0000-0000-0000-000000000110'
), payload AS (
  SELECT b.snapshot,public.fiscal_snapshot_hash(b.snapshot) AS hash FROM base b
)
SELECT t.*
FROM payload p
CROSS JOIN LATERAL public.transicionar_emision_fiscal(
  'f4000000-0000-0000-0000-000000000111','RESERVAR',
  'e4000000-0000-0000-0000-000000000111',
  jsonb_build_object(
    'expected_version',1,
    'snapshot',jsonb_set(p.snapshot,'{hash}',to_jsonb(p.hash)),
    'snapshot_hash',p.hash,'numero_propuesto',1,
    'fecha_comprobante','2026-08-22','emisor_cuit','30714199664',
    'punto_venta',991,'cbte_tipo',8,'modo','PRODUCCION','simulado',false,
    'validez','PRODUCCION','ultimo_remoto',0,'ultimo_local_observado',0
  )
) AS t;
SQL
} 2>&1)"; then
  echo "FALLO: la NC se reservó mientras el original quedaba incompatible" >&2
  exit 1
fi
wait "$LOCK_PID"
LOCK_PID=""
if [[ "$NC_RACE_OUTPUT" != *"NC asociada:"* ]]; then
  echo "$NC_RACE_OUTPUT" >&2
  echo "FALLO: la carrera de NC falló por un motivo inesperado" >&2
  exit 1
fi
NC_RACE_STATE="$(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq <<'SQL'
SELECT nc.afip_estado||'|'||nc.afip_fase||'|'||nc.afip_version::text||'|'||
       COALESCE(nc.afip_numero::text,'NULL')||'|'||
       COALESCE(o.venta_anulada_por::text,'NULL')
  FROM public.ventas nc
  JOIN public.ventas o ON o.id=nc.afip_cbte_asoc_id
 WHERE nc.id='f4000000-0000-0000-0000-000000000111';
SQL
)"
if [[ "$NC_RACE_STATE" != "EMITIENDO|PREFLIGHT|1|NULL|NULL" ]]; then
  echo "FALLO: carrera NC dejó estado incompatible: $NC_RACE_STATE" >&2
  exit 1
fi
echo "✓ reserva concurrente de NC espera al original y falla cerrada si cambia"

cleanup_concurrency_fixture
trap - EXIT

echo "✅ venta fiscal atómica: contrato completo en verde"
