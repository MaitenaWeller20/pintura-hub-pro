-- Activar/desactivar una cuenta cruza dos sistemas que no comparten una
-- transaccion: public.profiles y GoTrue. Esta tabla conserva la intencion mas
-- nueva y una version monotona. Mientras una transicion esta pendiente, el
-- perfil queda inactivo; una respuesta vieja nunca puede volver a publicarlo.

CREATE TABLE public.usuario_estado_acceso (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  activo_deseado boolean NOT NULL,
  operacion_id uuid UNIQUE,
  pendiente boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

-- El estado conserva sólo la intención vigente. Este historial mínimo conserva
-- las claves ya consumidas para que un retry tardío no vuelva a convertir una
-- operación supersedida en una intención nueva.
CREATE TABLE public.usuario_estado_acceso_operaciones (
  operacion_id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  activo_deseado boolean NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('CAMBIO','RECONCILIACION')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (profile_id,version)
);

INSERT INTO public.usuario_estado_acceso(
  profile_id,version,activo_deseado,operacion_id,pendiente
)
SELECT p.id,0,p.activo,NULL,false
  FROM public.profiles AS p;

ALTER TABLE public.usuario_estado_acceso ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuario_estado_acceso_operaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.usuario_estado_acceso
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.usuario_estado_acceso_operaciones
  FROM PUBLIC,anon,authenticated,service_role;
-- Sin policies ni grants directos: el unico contrato es el trio de RPC
-- service_role-only que usa el backend despues de revalidar al admin actor.

CREATE OR REPLACE FUNCTION public.guard_profile_activo_transicion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_operacion uuid;
BEGIN
  IF NEW.activo IS NOT DISTINCT FROM OLD.activo THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_operacion := NULLIF(
      pg_catalog.current_setting('app.usuario_activo_operacion',true),
      ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_operacion := NULL;
  END;

  IF v_operacion IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.usuario_estado_acceso AS e
     WHERE e.profile_id=NEW.id
       AND e.operacion_id=v_operacion
       AND e.pendiente
       AND (NEW.activo=false OR NEW.activo=e.activo_deseado)
  ) THEN
    RAISE insufficient_privilege
      USING MESSAGE='El estado de acceso sólo puede cambiar mediante la transición versionada';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_activo_transicion()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS trg_profiles_activo_transicion ON public.profiles;
CREATE TRIGGER trg_profiles_activo_transicion
  BEFORE UPDATE OF activo ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_activo_transicion();

-- Un administrador bloqueado en GoTrue tampoco es un administrador efectivo.
-- Esto cierra la ventana fail-safe profile=true/Auth=banned incluso para un JWT
-- emitido antes del ban.
CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles AS ur
      JOIN public.profiles AS p ON p.id=ur.user_id
      JOIN auth.users AS au ON au.id=p.id
     WHERE ur.user_id=_user_id
       AND ur.role='admin'::public.app_role
       AND p.activo
       AND au.deleted_at IS NULL
       AND (au.banned_until IS NULL OR au.banned_until<=pg_catalog.now())
  )
$$;

CREATE OR REPLACE FUNCTION public.current_sucursal_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT p.sucursal_id
    FROM public.profiles AS p
    JOIN auth.users AS au ON au.id=p.id
   WHERE p.id=auth.uid()
     AND p.activo
     AND au.deleted_at IS NULL
     AND (au.banned_until IS NULL OR au.banned_until<=pg_catalog.now())
$$;

CREATE OR REPLACE FUNCTION public.puede_vender_sin_stock(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT public.is_admin(_uid)
      OR EXISTS (
        SELECT 1
          FROM public.profiles AS p
          JOIN auth.users AS au ON au.id=p.id
         WHERE p.id=_uid
           AND p.activo
           AND p.permite_venta_sin_stock
           AND au.deleted_at IS NULL
           AND (au.banned_until IS NULL OR au.banned_until<=pg_catalog.now())
      )
$$;

CREATE OR REPLACE FUNCTION public.validar_perfil_activo_postgrest()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_rol text := NULLIF(pg_catalog.current_setting('role',true),'');
  v_uid uuid := auth.uid();
BEGIN
  IF v_rol IS DISTINCT FROM 'authenticated' THEN
    RETURN;
  END IF;

  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS p
      JOIN auth.users AS au ON au.id=p.id
     WHERE p.id=v_uid
       AND p.activo
       AND au.deleted_at IS NULL
       AND (au.banned_until IS NULL OR au.banned_until<=pg_catalog.now())
  ) THEN
    RAISE insufficient_privilege
      USING MESSAGE='El perfil autenticado no existe o está inactivo, o su acceso está bloqueado';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.iniciar_transicion_usuario_activo(
  p_actor_id uuid,
  p_profile_id uuid,
  p_activo boolean,
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
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE insufficient_privilege USING MESSAGE='RPC reservada al backend';
  END IF;
  IF p_operacion_id IS NULL THEN
    RAISE EXCEPTION 'La operación idempotente es obligatoria';
  END IF;
  IF p_actor_id IS NULL OR NOT public.is_admin(p_actor_id) THEN
    RAISE insufficient_privilege USING MESSAGE='Sólo un administrador activo puede cambiar accesos';
  END IF;

  SELECT * INTO v_perfil
    FROM public.profiles
   WHERE id=p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente';
  END IF;

  INSERT INTO public.usuario_estado_acceso(
    profile_id,version,activo_deseado,operacion_id,pendiente
  ) VALUES (p_profile_id,0,v_perfil.activo,NULL,false)
  ON CONFLICT (profile_id) DO NOTHING;

  SELECT * INTO v_estado
    FROM public.usuario_estado_acceso
   WHERE profile_id=p_profile_id
   FOR UPDATE;

  SELECT * INTO v_operacion
    FROM public.usuario_estado_acceso_operaciones
   WHERE operacion_id=p_operacion_id;
  IF FOUND THEN
    IF v_operacion.profile_id IS DISTINCT FROM p_profile_id THEN
      RAISE EXCEPTION 'La operación idempotente pertenece a otro usuario';
    END IF;
    IF v_operacion.activo_deseado IS DISTINCT FROM p_activo THEN
      RAISE EXCEPTION 'La operación idempotente ya existe con otra intención';
    END IF;
    IF v_operacion.version=v_estado.version
       AND v_estado.operacion_id=p_operacion_id
       AND v_estado.pendiente
       AND v_perfil.activo THEN
      PERFORM pg_catalog.set_config(
        'app.usuario_activo_operacion',p_operacion_id::text,true
      );
      UPDATE public.profiles SET activo=false WHERE id=p_profile_id;
      v_perfil.activo := false;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'version',v_estado.version,
      'activo_deseado',v_estado.activo_deseado,
      'pendiente',v_estado.pendiente,
      'activo_actual',v_perfil.activo,
      'operacion_id',v_estado.operacion_id,
      'idempotente',true,
      'supersedida',NOT (
        v_operacion.version=v_estado.version
        AND v_estado.operacion_id=p_operacion_id
      )
    );
  END IF;

  v_nueva_version := v_estado.version+1;
  INSERT INTO public.usuario_estado_acceso_operaciones(
    operacion_id,profile_id,version,activo_deseado,tipo
  ) VALUES (
    p_operacion_id,p_profile_id,v_nueva_version,p_activo,'CAMBIO'
  );

  UPDATE public.usuario_estado_acceso
     SET version=v_nueva_version,
         activo_deseado=p_activo,
         operacion_id=p_operacion_id,
         pendiente=true,
         updated_at=pg_catalog.now()
   WHERE profile_id=p_profile_id
  RETURNING * INTO v_estado;

  PERFORM pg_catalog.set_config(
    'app.usuario_activo_operacion',p_operacion_id::text,true
  );
  UPDATE public.profiles SET activo=false WHERE id=p_profile_id;

  RETURN pg_catalog.jsonb_build_object(
    'version',v_estado.version,
    'activo_deseado',v_estado.activo_deseado,
    'pendiente',true,
    'activo_actual',false,
    'operacion_id',v_estado.operacion_id,
    'idempotente',false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalizar_transicion_usuario_activo(
  p_profile_id uuid,
  p_version bigint,
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
  v_aplicada boolean := false;
  v_replay boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE insufficient_privilege USING MESSAGE='RPC reservada al backend';
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

  IF v_estado.version=p_version AND v_estado.operacion_id=p_operacion_id THEN
    IF v_estado.pendiente THEN
      PERFORM pg_catalog.set_config(
        'app.usuario_activo_operacion',p_operacion_id::text,true
      );
      UPDATE public.profiles
         SET activo=v_estado.activo_deseado
       WHERE id=p_profile_id;
      UPDATE public.usuario_estado_acceso
         SET pendiente=false,updated_at=pg_catalog.now()
       WHERE profile_id=p_profile_id
      RETURNING * INTO v_estado;
      v_perfil.activo := v_estado.activo_deseado;
    ELSE
      IF v_perfil.activo IS DISTINCT FROM v_estado.activo_deseado THEN
        RAISE EXCEPTION 'La transición estable no coincide con el perfil';
      END IF;
      v_replay := true;
    END IF;
    v_aplicada := true;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'aplicada',v_aplicada,
    'supersedida',NOT v_aplicada,
    'replay',v_replay,
    'version',v_estado.version,
    'activo_deseado',v_estado.activo_deseado,
    'pendiente',v_estado.pendiente,
    'activo_actual',v_perfil.activo,
    'operacion_id',v_estado.operacion_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reclamar_reconciliacion_usuario_activo(
  p_profile_id uuid,
  p_version_observada bigint,
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
  v_reclamada boolean := false;
  v_nueva_version bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE insufficient_privilege USING MESSAGE='RPC reservada al backend';
  END IF;
  IF p_operacion_id IS NULL THEN
    RAISE EXCEPTION 'La operación de reconciliación es obligatoria';
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
    v_reclamada := (
      v_operacion.version=v_estado.version
      AND v_estado.operacion_id=p_operacion_id
    );
  ELSIF v_estado.version=p_version_observada AND NOT v_estado.pendiente THEN
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
    PERFORM pg_catalog.set_config(
      'app.usuario_activo_operacion',p_operacion_id::text,true
    );
    UPDATE public.profiles SET activo=false WHERE id=p_profile_id;
    v_perfil.activo := false;
    v_reclamada := true;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'reclamada',v_reclamada,
    'version',v_estado.version,
    'activo_deseado',v_estado.activo_deseado,
    'pendiente',v_estado.pendiente,
    'activo_actual',v_perfil.activo,
    'operacion_id',v_estado.operacion_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.iniciar_transicion_usuario_activo(uuid,uuid,boolean,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finalizar_transicion_usuario_activo(uuid,bigint,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reclamar_reconciliacion_usuario_activo(uuid,bigint,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.iniciar_transicion_usuario_activo(uuid,uuid,boolean,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalizar_transicion_usuario_activo(uuid,bigint,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reclamar_reconciliacion_usuario_activo(uuid,bigint,uuid)
  TO service_role;

COMMENT ON TABLE public.usuario_estado_acceso IS
  'CAS versionado de activación: mientras pendiente=true, profiles.activo permanece false.';
COMMENT ON TABLE public.usuario_estado_acceso_operaciones IS
  'Claves idempotentes ya consumidas; impide que un retry supersedido vuelva a ganar.';
COMMENT ON FUNCTION public.iniciar_transicion_usuario_activo(uuid,uuid,boolean,uuid) IS
  'Registra la intención más nueva e inactiva el perfil antes de tocar GoTrue; idempotente por operación.';
COMMENT ON FUNCTION public.finalizar_transicion_usuario_activo(uuid,bigint,uuid) IS
  'Publica el estado deseado sólo si versión y operación siguen vigentes; una llamada vieja queda supersedida.';
COMMENT ON FUNCTION public.reclamar_reconciliacion_usuario_activo(uuid,bigint,uuid) IS
  'Reclama por CAS un estado estable para reparar en GoTrue la intención vigente sin sobrescribir una más nueva.';

NOTIFY pgrst,'reload schema';
