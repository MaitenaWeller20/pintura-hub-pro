#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"
PSQL=(docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1)

q() { "${PSQL[@]}" -tAc "$1"; }
check() {
  local name="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] || {
    echo "✗ $name — esperaba '$expected', obtuvo '$actual'" >&2
    exit 1
  }
  echo "✓ $name"
}

check "existe credenciales_arca" "credenciales_arca" \
  "$(q "select to_regclass('public.credenciales_arca')::text")"
check "dos emisores con CUIT" "2" \
  "$(q "select count(*) from public.emisores where cuit in ('30714199664','30717322467')")"
check "cada PV coincide con su sucursal" "0" \
  "$(q "select count(*) from public.puntos_venta p join public.sucursales s on s.id=p.sucursal_id where p.emisor_id is distinct from s.emisor_id")"
check "O'Higgins queda inactiva" "false" \
  "$(q "select p.activo::text from public.puntos_venta p join public.sucursales s on s.id=p.sucursal_id where s.codigo::text='OHIGGINS'")"
check "General Paz conserva el PV productivo confirmado" "5|PRODUCCION|true" \
  "$(q "select p.numero::text||'|'||p.modo||'|'||p.activo::text from public.puntos_venta p join public.sucursales s on s.id=p.sucursal_id where s.codigo::text='GENERALPAZ'")"
check "credenciales con RLS" "true" \
  "$(q "select relrowsecurity::text from pg_class where oid='public.credenciales_arca'::regclass")"
check "se registra la prueba real antes de habilitar" "probada_at" \
  "$(q "select column_name from information_schema.columns where table_schema='public' and table_name='credenciales_arca' and column_name='probada_at'")"
check "padrón nace desactivado" "false" \
  "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='credenciales_arca' and column_name='padron_validacion_activa'")"
check "padrón registra prueba real" "padron_probado_at" \
  "$(q "select column_name from information_schema.columns where table_schema='public' and table_name='credenciales_arca' and column_name='padron_probado_at'")"
check "padrón registra sólo código cerrado" "padron_ultimo_error_codigo" \
  "$(q "select column_name from information_schema.columns where table_schema='public' and table_name='credenciales_arca' and column_name='padron_ultimo_error_codigo'")"
check "RLS de credenciales sigue activa" "true" \
  "$(q "select relrowsecurity::text from pg_class where oid='public.credenciales_arca'::regclass")"
check "authenticated sigue sin leer credenciales" "false" \
  "$(q "select has_table_privilege('authenticated','public.credenciales_arca','select')::text")"
check "credenciales sin policies de navegador" "0" \
  "$(q "select count(*) from pg_policies where schemaname='public' and tablename='credenciales_arca'")"
check "authenticated no puede leer credenciales" "false" \
  "$(q "select has_table_privilege('authenticated','public.credenciales_arca','select')::text")"
check "service_role sí puede leer credenciales" "true" \
  "$(q "select has_table_privilege('service_role','public.credenciales_arca','select')::text")"
check "trigger atómico de PV instalado" "trg_puntos_venta_reset_credenciales_arca" \
  "$(q "select tgname from pg_trigger where tgrelid='public.puntos_venta'::regclass and tgname='trg_puntos_venta_reset_credenciales_arca' and not tgisinternal")"
check "reset de PV conserva privilegios del invocador" "false" \
  "$(q "select prosecdef::text from pg_proc where oid='public.reset_credenciales_arca_por_punto_venta()'::regprocedure")"
check "reset de PV no es API pública" "false" \
  "$(q "select has_function_privilege('public','public.reset_credenciales_arca_por_punto_venta()','execute')::text")"
check "authenticated no puede mutar puntos de venta" "false" \
  "$(q "select has_table_privilege('authenticated','public.puntos_venta','update')::text")"

legacy_key_hash="$(q "select coalesce(md5(arca_key_enc),'') from public.fiscal_config where id=true")"
if [[ -n "$legacy_key_hash" ]]; then
  check "la clave existente se copió byte por byte" "$legacy_key_hash" \
    "$(q "select coalesce(md5(c.arca_key_enc),'') from public.credenciales_arca c join public.emisores e on e.id=c.emisor_id where e.cuit='30714199664' and c.ambiente='PRODUCCION'")"
  check "la credencial copiada queda deshabilitada" "false" \
    "$(q "select c.habilitada::text from public.credenciales_arca c join public.emisores e on e.id=c.emisor_id where e.cuit='30714199664' and c.ambiente='PRODUCCION'")"
fi

"${PSQL[@]}" <<'SQL'
BEGIN;

-- Fixture rollback-only: independiza esta prueba de secretos legacy ausentes.
INSERT INTO public.credenciales_arca (emisor_id, ambiente)
SELECT id, 'HOMOLOGACION'
FROM public.emisores
WHERE cuit = '30714199664'
ON CONFLICT (emisor_id, ambiente) DO NOTHING;

-- Cambiar la identidad fiscal invalida la prueba del padrón.
DO $$
DECLARE
  v_credencial uuid;
  v_emisor uuid;
BEGIN
  SELECT c.id, c.emisor_id INTO v_credencial, v_emisor
  FROM public.credenciales_arca c
  JOIN public.emisores e ON e.id = c.emisor_id
  WHERE e.cuit = '30714199664'
  ORDER BY c.ambiente
  LIMIT 1;

  IF v_credencial IS NULL OR v_emisor IS NULL THEN
    RAISE EXCEPTION 'faltan credencial/emisor para probar reset de padrón por CUIT';
  END IF;

  UPDATE public.credenciales_arca
  SET
    padron_probado_at = now(),
    padron_validacion_activa = true,
    padron_ultimo_error_codigo = 'CUIT_INACTIVO',
    padron_ultimo_error_at = now()
  WHERE id = v_credencial;

  UPDATE public.emisores SET cuit = '30714199663' WHERE id = v_emisor;

  IF EXISTS (
    SELECT 1
    FROM public.credenciales_arca
    WHERE id = v_credencial
      AND (
        padron_probado_at IS NOT NULL
        OR padron_validacion_activa
        OR padron_ultimo_error_codigo IS NOT NULL
        OR padron_ultimo_error_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'cambiar CUIT no reinició la validación de padrón';
  END IF;
END $$;

-- Cambiar el certificado también invalida la prueba del padrón.
DO $$
DECLARE
  v_credencial uuid;
  v_emisor uuid;
BEGIN
  SELECT c.id, c.emisor_id INTO v_credencial, v_emisor
  FROM public.credenciales_arca c
  JOIN public.emisores e ON e.id = c.emisor_id
  WHERE e.cuit = '30714199663'
  ORDER BY c.ambiente
  LIMIT 1;

  IF v_credencial IS NULL OR v_emisor IS NULL THEN
    RAISE EXCEPTION 'faltan credencial/emisor para probar reset de padrón por certificado';
  END IF;

  UPDATE public.credenciales_arca
  SET
    padron_probado_at = now(),
    padron_validacion_activa = true,
    padron_ultimo_error_codigo = 'CUIT_INACTIVO',
    padron_ultimo_error_at = now()
  WHERE id = v_credencial;

  UPDATE public.credenciales_arca
  SET arca_cert_enc = coalesce(arca_cert_enc, '') || '-padron-test'
  WHERE id = v_credencial;

  IF EXISTS (
    SELECT 1
    FROM public.credenciales_arca
    WHERE id = v_credencial
      AND (
        padron_probado_at IS NOT NULL
        OR padron_validacion_activa
        OR padron_ultimo_error_codigo IS NOT NULL
        OR padron_ultimo_error_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'cambiar certificado no reinició la validación de padrón';
  END IF;

  -- Aísla el fixture multiemisor legacy que sigue en esta transacción.
  UPDATE public.emisores SET cuit = '30714199664' WHERE id = v_emisor;
END $$;

-- El upsert del PV y el reset de credenciales deben ser una sola sentencia
-- atómica. El trigger temporal fuerza un fallo en el reset y la subtransacción
-- comprueba que tampoco sobreviva el cambio del PV.
DO $$
DECLARE
  v_emisor uuid;
  v_pv uuid;
BEGIN
  SELECT id INTO v_emisor FROM public.emisores WHERE cuit = '30714199664';
  SELECT p.id INTO v_pv
  FROM public.puntos_venta p
  JOIN public.sucursales s ON s.id = p.sucursal_id
  WHERE s.codigo::text = 'GENERALPAZ';

  IF v_emisor IS NULL OR v_pv IS NULL THEN
    RAISE EXCEPTION 'faltan emisor/PV para probar reset atómico';
  END IF;

  INSERT INTO public.credenciales_arca (emisor_id, ambiente)
  VALUES (v_emisor, 'HOMOLOGACION'), (v_emisor, 'PRODUCCION')
  ON CONFLICT (emisor_id, ambiente) DO NOTHING;

  UPDATE public.puntos_venta
  SET numero = 9001, modo = 'HOMOLOGACION', activo = true
  WHERE id = v_pv;

  UPDATE public.credenciales_arca
  SET
    probada_at = '2026-08-26 12:00:00+00',
    habilitada = true,
    padron_probado_at = '2026-08-26 12:00:00+00',
    padron_validacion_activa = true,
    padron_ultimo_error_codigo = NULL,
    padron_ultimo_error_at = NULL
  WHERE emisor_id = v_emisor;
END $$;

CREATE FUNCTION pg_temp.forzar_fallo_reset_pv()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RESET_PV_FORZADO';
END;
$$;

CREATE TRIGGER zz_forzar_fallo_reset_pv
  BEFORE UPDATE ON public.credenciales_arca
  FOR EACH ROW
  EXECUTE FUNCTION pg_temp.forzar_fallo_reset_pv();

DO $$
DECLARE
  v_pv uuid;
BEGIN
  SELECT p.id INTO v_pv
  FROM public.puntos_venta p
  JOIN public.sucursales s ON s.id = p.sucursal_id
  WHERE s.codigo::text = 'GENERALPAZ';

  BEGIN
    UPDATE public.puntos_venta SET numero = 9002 WHERE id = v_pv;
    RAISE EXCEPTION 'el cambio de PV sobrevivió sin ejecutar el reset atómico';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'RESET_PV_FORZADO' THEN
      RAISE;
    END IF;
  END;

  IF (SELECT numero FROM public.puntos_venta WHERE id = v_pv) <> 9001 THEN
    RAISE EXCEPTION 'el fallo del reset no revirtió el cambio de PV';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.credenciales_arca c
    JOIN public.emisores e ON e.id = c.emisor_id
    WHERE e.cuit = '30714199664'
      AND (c.probada_at IS NULL OR NOT c.habilitada)
  ) THEN
    RAISE EXCEPTION 'el fallo atómico alteró evidencia WSFE';
  END IF;
END $$;

DROP TRIGGER zz_forzar_fallo_reset_pv ON public.credenciales_arca;

-- Semántica completa del reset: no-op, número, modo, versión CAS y emisor.
DO $$
DECLARE
  v_emisor uuid;
  v_otro_emisor uuid;
  v_pv uuid;
  v_sucursal uuid;
  v_version_vieja timestamptz;
  v_filas integer;
BEGIN
  SELECT id INTO v_emisor FROM public.emisores WHERE cuit = '30714199664';
  SELECT id INTO v_otro_emisor FROM public.emisores WHERE cuit = '30717322467';
  SELECT p.id, p.sucursal_id INTO v_pv, v_sucursal
  FROM public.puntos_venta p
  JOIN public.sucursales s ON s.id = p.sucursal_id
  WHERE s.codigo::text = 'GENERALPAZ';

  -- Un no-op no toca evidencia ni la versión de credenciales.
  UPDATE public.credenciales_arca
  SET
    probada_at = '2026-08-26 12:00:00+00',
    habilitada = true,
    padron_probado_at = '2026-08-26 12:00:00+00',
    padron_validacion_activa = true
  WHERE emisor_id = v_emisor AND ambiente = 'HOMOLOGACION';
  SELECT updated_at INTO v_version_vieja
  FROM public.credenciales_arca
  WHERE emisor_id = v_emisor AND ambiente = 'HOMOLOGACION';

  INSERT INTO public.puntos_venta (sucursal_id, emisor_id, numero, modo, activo)
  VALUES (v_sucursal, v_emisor, 9001, 'HOMOLOGACION', true)
  ON CONFLICT (sucursal_id) DO UPDATE SET
    emisor_id = EXCLUDED.emisor_id,
    numero = EXCLUDED.numero,
    modo = EXCLUDED.modo,
    activo = EXCLUDED.activo;

  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE emisor_id = v_emisor AND ambiente = 'HOMOLOGACION'
      AND (
        probada_at IS DISTINCT FROM '2026-08-26 12:00:00+00'::timestamptz
        OR NOT habilitada
        OR padron_probado_at IS DISTINCT FROM '2026-08-26 12:00:00+00'::timestamptz
        OR NOT padron_validacion_activa
        OR updated_at IS DISTINCT FROM v_version_vieja
      )
  ) THEN
    RAISE EXCEPTION 'un upsert no-op reinició evidencia';
  END IF;

  -- Sólo el número reinicia WSFE pero conserva padrón.
  UPDATE public.puntos_venta SET numero = 9003 WHERE id = v_pv;
  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE emisor_id = v_emisor AND ambiente = 'HOMOLOGACION'
      AND (
        probada_at IS NOT NULL
        OR habilitada
        OR padron_probado_at IS DISTINCT FROM '2026-08-26 12:00:00+00'::timestamptz
        OR NOT padron_validacion_activa
      )
  ) THEN
    RAISE EXCEPTION 'cambiar número no respetó la separación WSFE/padrón';
  END IF;

  -- Prepara ambos ambientes y una versión inequívocamente vieja para CAS.
  UPDATE public.credenciales_arca
  SET
    probada_at = '2026-08-26 12:01:00+00',
    habilitada = true,
    padron_probado_at = '2026-08-26 12:01:00+00',
    padron_validacion_activa = true
  WHERE emisor_id = v_emisor;
  ALTER TABLE public.credenciales_arca DISABLE TRIGGER trg_credenciales_arca_upd;
  UPDATE public.credenciales_arca
  SET updated_at = '2020-01-01 00:00:00+00'
  WHERE emisor_id = v_emisor;
  ALTER TABLE public.credenciales_arca ENABLE TRIGGER trg_credenciales_arca_upd;
  SELECT updated_at INTO v_version_vieja
  FROM public.credenciales_arca
  WHERE emisor_id = v_emisor AND ambiente = 'HOMOLOGACION';

  UPDATE public.puntos_venta SET modo = 'PRODUCCION' WHERE id = v_pv;
  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE emisor_id = v_emisor
      AND ambiente IN ('HOMOLOGACION', 'PRODUCCION')
      AND (
        probada_at IS NOT NULL
        OR habilitada
        OR padron_probado_at IS NOT NULL
        OR padron_validacion_activa
        OR padron_ultimo_error_codigo IS NOT NULL
        OR padron_ultimo_error_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'cambiar modo no reinició ambos ambientes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE emisor_id = v_emisor AND updated_at <= v_version_vieja
  ) THEN
    RAISE EXCEPTION 'el reset de PV no avanzó updated_at para CAS';
  END IF;

  UPDATE public.credenciales_arca
  SET padron_probado_at = now(), padron_validacion_activa = true
  WHERE emisor_id = v_emisor
    AND ambiente = 'HOMOLOGACION'
    AND updated_at = v_version_vieja;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas <> 0 THEN
    RAISE EXCEPTION 'una activación CAS obsoleta sobrevivió al reset de PV';
  END IF;

  -- La función de trigger también cubre una reasociación excepcional de emisor.
  INSERT INTO public.credenciales_arca (emisor_id, ambiente)
  VALUES (v_otro_emisor, 'PRODUCCION')
  ON CONFLICT (emisor_id, ambiente) DO NOTHING;

  CREATE TEMP TABLE pv_reset_emisor_test (
    LIKE public.puntos_venta INCLUDING DEFAULTS
  ) ON COMMIT DROP;
  CREATE TRIGGER trg_pv_reset_emisor_test
    AFTER INSERT OR UPDATE ON pv_reset_emisor_test
    FOR EACH ROW
    EXECUTE FUNCTION public.reset_credenciales_arca_por_punto_venta();

  UPDATE public.credenciales_arca
  SET
    probada_at = now(),
    habilitada = true,
    padron_probado_at = now(),
    padron_validacion_activa = true
  WHERE emisor_id = v_emisor AND ambiente = 'PRODUCCION';
  INSERT INTO pv_reset_emisor_test (sucursal_id, emisor_id, numero, modo, activo)
  VALUES (v_sucursal, v_emisor, 9100, 'PRODUCCION', true);
  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE emisor_id = v_emisor AND ambiente = 'PRODUCCION'
      AND (
        probada_at IS NOT NULL
        OR habilitada
        OR padron_probado_at IS NOT NULL
        OR padron_validacion_activa
      )
  ) THEN
    RAISE EXCEPTION 'crear la asociación de PV no reinició WSFE y padrón';
  END IF;

  UPDATE public.credenciales_arca
  SET
    probada_at = now(),
    habilitada = true,
    padron_probado_at = now(),
    padron_validacion_activa = true
  WHERE (emisor_id = v_emisor OR emisor_id = v_otro_emisor)
    AND ambiente = 'PRODUCCION';
  UPDATE pv_reset_emisor_test SET emisor_id = v_otro_emisor;

  IF EXISTS (
    SELECT 1 FROM public.credenciales_arca
    WHERE (emisor_id = v_emisor OR emisor_id = v_otro_emisor)
      AND ambiente = 'PRODUCCION'
      AND (
        probada_at IS NOT NULL
        OR habilitada
        OR padron_probado_at IS NOT NULL
        OR padron_validacion_activa
      )
  ) THEN
    RAISE EXCEPTION 'cambiar emisor no reinició credenciales viejas y nuevas';
  END IF;
END $$;

-- Dos CUIT distintos pueden usar el mismo número de PV.
UPDATE public.puntos_venta SET numero=99, modo='HOMOLOGACION';

-- El mismo emisor no puede repetir el PV en otra sucursal.
DO $$
DECLARE
  v_emisor uuid;
  v_sucursal uuid;
BEGIN
  SELECT id INTO v_emisor FROM public.emisores WHERE cuit='30714199664';
  DELETE FROM public.puntos_venta p USING public.sucursales s
    WHERE s.id=p.sucursal_id AND s.codigo::text='OHIGGINS';
  UPDATE public.sucursales SET emisor_id=v_emisor WHERE codigo::text='OHIGGINS'
    RETURNING id INTO v_sucursal;
  BEGIN
    INSERT INTO public.puntos_venta (sucursal_id,emisor_id,numero,modo)
    VALUES (v_sucursal,v_emisor,99,'HOMOLOGACION');
    RAISE EXCEPTION 'el mismo emisor pudo repetir PV';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- La numeración fiscal se aísla por CUIT emisor, no sólo por PV.
INSERT INTO auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES (
  'aaaaaaaa-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','multiemisor@test.local','x',now(),now(),now()
);
INSERT INTO public.user_roles (user_id,role)
VALUES ('aaaaaaaa-1111-1111-1111-111111111111','admin');
INSERT INTO public.clientes (id,razon_social)
VALUES ('bbbbbbbb-1111-1111-1111-111111111111','CLIENTE TEST MULTIEMISOR');

-- Historia fiscal sintética previa al corte; esta transacción siempre revierte.
ALTER TABLE public.ventas DISABLE TRIGGER trg_ventas_fiscales_legacy_retirado;

INSERT INTO public.ventas (
  id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
  afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado
) VALUES
  ('cccccccc-1111-1111-1111-111111111111',
   (SELECT id FROM public.sucursales WHERE codigo::text='GENERALPAZ'),
   'bbbbbbbb-1111-1111-1111-111111111111','aaaaaaaa-1111-1111-1111-111111111111',
   'TEST-MULTI-1','FACTURA_B','30714199664',99,6,987654321,'HOMOLOGACION',false),
  ('cccccccc-2222-2222-2222-222222222222',
   (SELECT id FROM public.sucursales WHERE codigo::text='OHIGGINS'),
   'bbbbbbbb-1111-1111-1111-111111111111','aaaaaaaa-1111-1111-1111-111111111111',
   'TEST-MULTI-2','FACTURA_B','30717322467',99,6,987654321,'HOMOLOGACION',false);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas (
      id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado
    ) VALUES (
      'cccccccc-3333-3333-3333-333333333333',
      (SELECT id FROM public.sucursales WHERE codigo::text='GENERALPAZ'),
      'bbbbbbbb-1111-1111-1111-111111111111','aaaaaaaa-1111-1111-1111-111111111111',
      'TEST-MULTI-3','FACTURA_B','30714199664',99,6,987654321,'HOMOLOGACION',false
    );
    RAISE EXCEPTION 'el mismo CUIT pudo repetir numeración fiscal';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.ventas (
      id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado
    ) VALUES (
      'cccccccc-4444-4444-4444-444444444444',
      (SELECT id FROM public.sucursales WHERE codigo::text='GENERALPAZ'),
      'bbbbbbbb-1111-1111-1111-111111111111','aaaaaaaa-1111-1111-1111-111111111111',
      'TEST-MULTI-4','FACTURA_B',NULL,98,6,987654322,'HOMOLOGACION',false
    );
    RAISE EXCEPTION 'se guardó numeración fiscal sin CUIT emisor';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

ALTER TABLE public.ventas ENABLE TRIGGER trg_ventas_fiscales_legacy_retirado;

-- Aunque tenga permiso para crear la venta, authenticated no puede adjudicar
-- el CUIT fiscal desde el navegador.
GRANT INSERT ON public.ventas TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"aaaaaaaa-1111-1111-1111-111111111111","role":"authenticated"}';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.ventas (
      id,sucursal_id,cliente_id,usuario_id,numero_comprobante,tipo_comprobante,
      afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,afip_numero,afip_modo,afip_simulado
    ) VALUES (
      'cccccccc-5555-5555-5555-555555555555',
      (SELECT id FROM public.sucursales WHERE codigo::text='GENERALPAZ'),
      'bbbbbbbb-1111-1111-1111-111111111111','aaaaaaaa-1111-1111-1111-111111111111',
      'TEST-MULTI-5','FACTURA_B','30714199664',97,6,987654323,'HOMOLOGACION',false
    );
    RAISE EXCEPTION 'authenticated pudo asignar el CUIT emisor';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'El CUIT emisor fiscal sólo lo asigna el servidor' THEN
      RAISE;
    END IF;
  END;
END $$;
RESET ROLE;

ROLLBACK;
SQL

echo "✅ Contrato multiemisor correcto."
