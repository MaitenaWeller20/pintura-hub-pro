#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL=(docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1)

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
check "credenciales con RLS" "true" \
  "$(q "select relrowsecurity::text from pg_class where oid='public.credenciales_arca'::regclass")"
check "credenciales sin policies de navegador" "0" \
  "$(q "select count(*) from pg_policies where schemaname='public' and tablename='credenciales_arca'")"
check "authenticated no puede leer credenciales" "false" \
  "$(q "select has_table_privilege('authenticated','public.credenciales_arca','select')::text")"
check "service_role sí puede leer credenciales" "true" \
  "$(q "select has_table_privilege('service_role','public.credenciales_arca','select')::text")"

legacy_key_hash="$(q "select coalesce(md5(arca_key_enc),'') from public.fiscal_config where id=true")"
if [[ -n "$legacy_key_hash" ]]; then
  check "la clave existente se copió byte por byte" "$legacy_key_hash" \
    "$(q "select coalesce(md5(c.arca_key_enc),'') from public.credenciales_arca c join public.emisores e on e.id=c.emisor_id where e.cuit='30714199664' and c.ambiente='PRODUCCION'")"
  check "la credencial copiada queda deshabilitada" "false" \
    "$(q "select c.habilitada::text from public.credenciales_arca c join public.emisores e on e.id=c.emisor_id where e.cuit='30714199664' and c.ambiente='PRODUCCION'")"
fi

"${PSQL[@]}" <<'SQL'
BEGIN;

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
