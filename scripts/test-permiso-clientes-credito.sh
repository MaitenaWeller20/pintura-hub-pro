#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
DB="${DB:-supabase_db_${PROJECT_ID}}"

docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

INSERT INTO auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at
) VALUES
  ('a5260000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','permiso-credito-admin@test.local','x',now(),now(),now()),
  ('a5260000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','permiso-credito-empleado@test.local','x',now(),now(),now());

UPDATE public.profiles
   SET activo=true,
       sucursal_id=(SELECT id FROM public.sucursales WHERE activa ORDER BY numero LIMIT 1)
 WHERE id IN (
   'a5260000-0000-4000-8000-000000000001',
   'a5260000-0000-4000-8000-000000000002'
 );

INSERT INTO public.user_roles(user_id,role)
VALUES ('a5260000-0000-4000-8000-000000000001','admin');

DO $$
DECLARE
  v_cliente uuid;
  v_rechazado boolean := false;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub','a5260000-0000-4000-8000-000000000002',
      'role','authenticated'
    )::text,
    true
  );

  BEGIN
    INSERT INTO public.clientes(razon_social,condicion_cta_cte,limite_credito)
    VALUES ('Cliente crédito denegado',true,50000);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_rechazado := true;
  END;
  IF NOT v_rechazado THEN
    RAISE EXCEPTION 'El empleado se otorgó crédito sin permiso';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub','a5260000-0000-4000-8000-000000000001',
      'role','authenticated'
    )::text,
    true
  );
  PERFORM public.administrar_puede_gestionar_credito_clientes(
    'a5260000-0000-4000-8000-000000000002',true
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub','a5260000-0000-4000-8000-000000000002',
      'role','authenticated'
    )::text,
    true
  );
  INSERT INTO public.clientes(razon_social,condicion_cta_cte,limite_credito)
  VALUES ('Cliente crédito permitido',true,50000)
  RETURNING id INTO v_cliente;

  IF NOT public.puede_gestionar_credito_clientes(
    'a5260000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'La capacidad efectiva no refleja el permiso';
  END IF;

  v_rechazado := false;
  BEGIN
    UPDATE public.profiles
       SET puede_gestionar_credito_clientes=false
     WHERE id='a5260000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_rechazado := true;
  END;
  IF NOT v_rechazado THEN
    RAISE EXCEPTION 'El empleado pudo quitarse el permiso directamente';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub','a5260000-0000-4000-8000-000000000001',
      'role','authenticated'
    )::text,
    true
  );
  PERFORM public.administrar_puede_gestionar_credito_clientes(
    'a5260000-0000-4000-8000-000000000002',false
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub','a5260000-0000-4000-8000-000000000002',
      'role','authenticated'
    )::text,
    true
  );
  v_rechazado := false;
  BEGIN
    UPDATE public.clientes SET limite_credito=75000 WHERE id=v_cliente;
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_rechazado := true;
  END;
  IF NOT v_rechazado THEN
    RAISE EXCEPTION 'El permiso revocado siguió permitiendo modificar crédito';
  END IF;
END;
$$;

ROLLBACK;
SQL

echo "✅ Permiso de cuenta corriente verificado."
