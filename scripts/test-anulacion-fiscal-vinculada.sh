#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_ok boolean,p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALLO: %',p_message;
  END IF;
  RAISE NOTICE '✓ %',p_message;
END;
$$;

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'a2410000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'nc-vinculada@test.local','x',now(),now(),now()
);
UPDATE public.profiles
   SET username='nc_vinculada',activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1)
 WHERE id='a2410000-0000-4000-8000-000000000001';
INSERT INTO public.user_roles(user_id,role)
VALUES ('a2410000-0000-4000-8000-000000000001','admin');
INSERT INTO public.profile_sucursales(profile_id,sucursal_id)
SELECT 'a2410000-0000-4000-8000-000000000001',id
  FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"a2410000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

INSERT INTO public.clientes(
  id,razon_social,tipo,condicion_cta_cte,limite_credito,activo,es_generico
) VALUES (
  'b2410000-0000-4000-8000-000000000001','CLIENTE NC VINCULADA',
  'CONSUMIDOR_FINAL',true,99999999,true,false
);
INSERT INTO public.productos(
  id,codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado
) VALUES (
  'c2410000-0000-4000-8000-000000000001','NC-VINCULADA',
  'PRODUCTO NC VINCULADA',1000,21,true,false
);
INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
SELECT 'c2410000-0000-4000-8000-000000000001',id,10
  FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1;

UPDATE public.caja_sesiones
   SET estado='CERRADA',cerrada_en=COALESCE(cerrada_en,now())
 WHERE sucursal_id=(SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1)
   AND estado='ABIERTA';
INSERT INTO public.caja_sesiones(id,sucursal_id,estado,abierta_por,fondo_inicial)
SELECT 'd2410000-0000-4000-8000-000000000001',id,'ABIERTA',
       'a2410000-0000-4000-8000-000000000001',0
  FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1;

UPDATE public.settings
   SET facturacion_receptor_v2_enabled=true,
       facturacion_legacy_writer_enabled=false
 WHERE id=true;

CREATE OR REPLACE FUNCTION pg_temp.factura_snapshot_v2(
  p_venta_id uuid,p_punto_venta integer,p_numero integer,p_total text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v public.ventas%ROWTYPE;
  s jsonb;
  h text;
BEGIN
  SELECT x.* INTO STRICT v FROM public.ventas x WHERE x.id=p_venta_id;
  s := pg_catalog.jsonb_build_object(
    'version',2,'hash','',
    'venta',pg_catalog.jsonb_build_object(
      'id',v.id,'numeroComercial',v.numero_comprobante,'tipoComprobante','VENTA',
      'condicionVenta',v.condicion_venta,'fechaComercial','2026-08-22T12:00:00.000Z'
    ),
    'items',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id','71000000-0000-4000-8000-000000000011',
        'productoId','c2410000-0000-4000-8000-000000000001',
        'codigo','NC-VINCULADA','descripcion','PRODUCTO NC VINCULADA','cantidad','1.00',
        'precioUnitarioSinIva','1000.00','descuentoPorcentaje','0.00',
        'ivaPorcentaje','21.00','subtotalNeto','1000.00',
        'importeIva','210.00','subtotalTotal','1210.00'
      )
    ),
    'emisor',pg_catalog.jsonb_build_object(
      'id','71000000-0000-4000-8000-000000000201',
      'razonSocial','APLICACIONES Y SERVICIOS S.R.L.','nombreFantasia','CasaForma',
      'cuit','30714199664','domicilioFiscal','SARMIENTO 1398 - CÓRDOBA',
      'condicionIva','RESPONSABLE_INSCRIPTO','ingresosBrutos','280970280',
      'inicioActividades','2013-10-01','telefono','3513229459'
    ),
    'sucursal',pg_catalog.jsonb_build_object(
      'id',v.sucursal_id,'nombre','CasaForma','direccion','Sarmiento 1398','telefono',NULL
    ),
    'receptor',pg_catalog.jsonb_build_object(
      'razonSocial','CLIENTE NC VINCULADA','domicilio',NULL,'tipoDocumento','DNI',
      'numeroDocumento','30111222','docTipoArca',96,'docNroArca','30111222',
      'condicionIva','CONSUMIDOR_FINAL','origen','CLIENTE_COMERCIAL',
      'origenId',v.cliente_id,'verificadoArcaAt',NULL,'condicionIvaReceptorId',5
    ),
    'identidad',pg_catalog.jsonb_build_object(
      'numero',p_numero,'emisorCuit','30714199664','puntoVenta',p_punto_venta,
      'cbteTipo',6,'modo','PRODUCCION','simulado',false,'validez','PRODUCCION'
    ),
    'letra','B','concepto',1,'fechaComprobante','2026-08-22',
    'importeNeto','1000.00','importeExento','0.00','importeNoGravado','0.00',
    'importeIva','210.00','importeTributos','0.00','importeTotal',p_total,
    'alicuotasIva',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id',5,'baseImponible','1000.00','importe','210.00')
    ),
    'tributos','[]'::jsonb,'moneda','PES','cotizacion','1.000000',
    'ivaContenido','210.00','otrosImpuestosNacionalesIndirectos','0.00',
    'origen','VENTA','comprobanteOriginalId',NULL,'cbtesAsoc','[]'::jsonb
  );
  h := public.fiscal_snapshot_hash(s);
  RETURN pg_catalog.jsonb_set(s,'{hash}',pg_catalog.to_jsonb(h));
END;
$$;

CREATE TEMP TABLE t_original AS
SELECT * FROM public.crear_venta(
  (SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1),
  'b2410000-0000-4000-8000-000000000001','VENTA','CTA_CTE',
  '[{"producto_id":"c2410000-0000-4000-8000-000000000001","cantidad":1}]'::jsonb,
  '[]'::jsonb,0,'Regresión NC fiscal vinculada',NULL,NULL,NULL,
  'e2410000-0000-4000-8000-000000000001'
);

UPDATE public.ventas
   SET afip_estado='APROBADO',afip_fase='PERSISTIDO',afip_version=2,
       afip_emisor_cuit='30714199664',afip_punto_venta=997,afip_cbte_tipo=6,
       afip_numero=997041,afip_modo='PRODUCCION',afip_simulado=false,
       afip_validez='PRODUCCION',afip_fecha_comprobante='2026-08-22',
       afip_imp_total=1210,
       afip_snapshot=pg_temp.factura_snapshot_v2(id,997,997041,'1210.00'),
       afip_snapshot_hash=pg_temp.factura_snapshot_v2(id,997,997041,'1210.00')->>'hash',
       cae='CAE-NC-VINCULADA',cae_vencimiento='2026-09-01',afip_emitido_at=now()
 WHERE id=(SELECT venta_id FROM t_original);

CREATE TEMP TABLE t_nc AS
SELECT * FROM public.anular_venta(
  (SELECT venta_id FROM t_original),
  'e2410000-0000-4000-8000-000000000002'
);
CREATE TEMP TABLE t_replay AS
SELECT * FROM public.anular_venta(
  (SELECT venta_id FROM t_original),
  'e2410000-0000-4000-8000-000000000002'
);

SELECT pg_temp.assert_true(
  (SELECT n.nc_id=r.nc_id AND n.nc_numero=r.nc_numero FROM t_nc n CROSS JOIN t_replay r)
  AND (SELECT count(*)=1 FROM public.ventas
        WHERE idempotency_key='e2410000-0000-4000-8000-000000000002'),
  'la reversión vinculada es idempotente y crea una sola nota'
);
SELECT pg_temp.assert_true((
  SELECT o.estado='ANULADA'
     AND o.venta_anulada_por=n.id
     AND n.tipo_comprobante='NOTA_CREDITO'
     AND n.estado='ACTIVA'
     AND n.afip_estado='SIN_FACTURAR'
     AND n.afip_cbte_asoc_id=o.id
     AND n.total=-pg_catalog.abs(o.total)
     AND n.subtotal_sin_iva=-pg_catalog.abs(o.subtotal_sin_iva)
     AND n.iva_total=-pg_catalog.abs(o.iva_total)
     AND n.nc_periodo_modalidad IS NULL
     AND n.periodo_asoc_desde IS NULL
     AND n.periodo_asoc_hasta IS NULL
     AND n.nc_periodo_payload_hash IS NULL
    FROM public.ventas o
    JOIN public.ventas n ON n.id=o.venta_anulada_por
   WHERE o.id=(SELECT venta_id FROM t_original)
),'la reversión total conserva la NC fiscal vinculada fuera del flujo por período');
SELECT pg_temp.assert_true(
  (SELECT cantidad=10 FROM public.stock_sucursal
    WHERE producto_id='c2410000-0000-4000-8000-000000000001'
      AND sucursal_id=(SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1)),
  'la reversión vinculada repone el stock una sola vez'
);

ROLLBACK;
SQL

echo "✓ Reversión fiscal total vinculada verificada de forma independiente."
