-- Ultimo recurso del coordinador profile/GoTrue. Si una sucesion de cambios
-- concurrentes impide confirmar por CAS que Auth y el perfil coinciden, esta
-- RPC toma la intención vigente bajo lock, crea una reconciliación más nueva y
-- deja el perfil cerrado. No finaliza la reconciliación: el administrador debe
-- reintentar y nunca recibe un falso éxito.

CREATE OR REPLACE FUNCTION public.forzar_cierre_usuario_activo_fail_safe(
  p_profile_id uuid,
  p_operacion_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_perfil public.profiles%ROWTYPE;
  v_estado public.usuario_estado_acceso%ROWTYPE;
  v_operacion public.usuario_estado_acceso_operaciones%ROWTYPE;
  v_nueva_version bigint;
  v_replay boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE insufficient_privilege USING MESSAGE='RPC reservada al backend';
  END IF;
  IF p_operacion_id IS NULL THEN
    RAISE EXCEPTION 'La operación fail-safe es obligatoria';
  END IF;

  SELECT * INTO v_perfil
    FROM public.profiles
   WHERE id=p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente';
  END IF;

  SELECT * INTO v_estado
    FROM public.usuario_estado_acceso
   WHERE profile_id=p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La transición de acceso no existe';
  END IF;

  SELECT * INTO v_operacion
    FROM public.usuario_estado_acceso_operaciones
   WHERE operacion_id=p_operacion_id;
  IF FOUND THEN
    IF v_operacion.profile_id IS DISTINCT FROM p_profile_id THEN
      RAISE EXCEPTION 'La operación idempotente pertenece a otro usuario';
    END IF;
    IF v_operacion.tipo IS DISTINCT FROM 'RECONCILIACION' THEN
      RAISE EXCEPTION 'La operación idempotente pertenece a otro propósito';
    END IF;
    IF v_operacion.version IS DISTINCT FROM v_estado.version
       OR v_estado.operacion_id IS DISTINCT FROM p_operacion_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'forzada',false,
        'supersedida',true,
        'replay',true,
        'version',v_estado.version,
        'activo_deseado',v_estado.activo_deseado,
        'pendiente',v_estado.pendiente,
        'activo_actual',v_perfil.activo,
        'operacion_id',v_estado.operacion_id
      );
    END IF;
    v_replay := true;
  ELSE
    v_nueva_version := v_estado.version+1;
    INSERT INTO public.usuario_estado_acceso_operaciones(
      operacion_id,profile_id,version,activo_deseado,tipo
    ) VALUES (
      p_operacion_id,p_profile_id,v_nueva_version,
      v_estado.activo_deseado,'RECONCILIACION'
    );
    UPDATE public.usuario_estado_acceso
       SET version=v_nueva_version,
           operacion_id=p_operacion_id,
           pendiente=true,
           updated_at=pg_catalog.now()
     WHERE profile_id=p_profile_id
    RETURNING * INTO v_estado;
  END IF;

  -- También en replay se vuelve a cerrar. Así una respuesta perdida seguida
  -- por una finalización ajena no convierte el retry fail-safe en un no-op.
  UPDATE public.usuario_estado_acceso
     SET pendiente=true,updated_at=pg_catalog.now()
   WHERE profile_id=p_profile_id
  RETURNING * INTO v_estado;
  PERFORM pg_catalog.set_config(
    'app.usuario_activo_operacion',p_operacion_id::text,true
  );
  UPDATE public.profiles SET activo=false WHERE id=p_profile_id;

  RETURN pg_catalog.jsonb_build_object(
    'forzada',true,
    'supersedida',false,
    'replay',v_replay,
    'version',v_estado.version,
    'activo_deseado',v_estado.activo_deseado,
    'pendiente',true,
    'activo_actual',false,
    'operacion_id',v_estado.operacion_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.forzar_cierre_usuario_activo_fail_safe(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.forzar_cierre_usuario_activo_fail_safe(uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.forzar_cierre_usuario_activo_fail_safe(uuid,uuid) IS
  'Preserva la intención vigente y deja profile=false/pending tras agotar la reconciliación profile/GoTrue; idempotente y service_role-only.';

NOTIFY pgrst,'reload schema';
