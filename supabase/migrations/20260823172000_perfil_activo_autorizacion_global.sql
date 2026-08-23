-- Un JWT puede seguir siendo válido después de desactivar un usuario. El rol
-- persistido no alcanza: toda autorización efectiva exige también un perfil
-- existente y activo. Al redefinir estos dos helpers en una sola transacción,
-- las policies y RPC existentes dejan de reconocer al actor en el mismo commit.

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles AS ur
      JOIN public.profiles AS p ON p.id=ur.user_id
     WHERE ur.user_id=_user_id
       AND ur.role='admin'::public.app_role
       AND p.activo
  )
$$;

CREATE OR REPLACE FUNCTION public.current_sucursal_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.sucursal_id
    FROM public.profiles AS p
   WHERE p.id=auth.uid()
     AND p.activo
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
         WHERE p.id=_uid
           AND p.activo
           AND p.permite_venta_sin_stock
      )
$$;

REVOKE ALL ON FUNCTION public.puede_vender_sin_stock(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.puede_vender_sin_stock(uuid)
  TO authenticated,service_role;

-- `profiles` permite que cada usuario edite su propia fila. Este trigger es la
-- barrera por columna: un admin desactivado ya no puede aprovechar su rol viejo
-- para auto-reactivarse. El backend service-role (auth.uid() NULL) sigue siendo
-- el canal interno con el que otro administrador activo aplica la gestión.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- La capacidad fiscal nunca se cambia con service-role sin identidad. La
  -- RPC administrar_puede_facturar conserva el JWT del admin activo.
  IF NEW.puede_facturar IS DISTINCT FROM OLD.puede_facturar
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'No puede modificar el permiso fiscal de su propio perfil';
  END IF;

  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    IF NEW.sucursal_id IS NULL THEN
      RAISE EXCEPTION 'No te podés quedar sin sucursal: elegí en cuál estás trabajando';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=NEW.id
         AND ps.sucursal_id=NEW.sucursal_id
    ) THEN
      RAISE EXCEPTION 'No trabajás en esa sucursal. Pedile a un administrador que te habilite.';
    END IF;
  END IF;

  IF NEW.activo IS DISTINCT FROM OLD.activo THEN
    RAISE EXCEPTION 'Sólo un administrador puede activar o desactivar un usuario';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'El nombre de usuario no se puede cambiar';
  END IF;
  IF NEW.permite_venta_sin_stock IS DISTINCT FROM OLD.permite_venta_sin_stock THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar el permiso de venta sin stock';
  END IF;
  IF NEW.secciones IS DISTINCT FROM OLD.secciones THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar las secciones de un usuario';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profiles_columnas()
  FROM PUBLIC,anon,authenticated;

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'Rol admin efectivo: exige user_roles.admin y un perfil existente y activo; seguro ante JWT obsoleto.';
COMMENT ON FUNCTION public.current_sucursal_id() IS
  'Sucursal efectiva del actor autenticado; devuelve NULL si el perfil no existe o está inactivo.';
COMMENT ON FUNCTION public.puede_vender_sin_stock(uuid) IS
  'Capacidad efectiva de vender sin stock: exige perfil activo, incluso con JWT o rol persistido obsoleto.';

-- Dos remitos inversos (A→B y B→A) deben tomar los mismos pares de stock en
-- el mismo orden. Sin este prelock, cada aprobación podía conservar una fila y
-- esperar la otra hasta que PostgreSQL abortara una de ellas por deadlock.
CREATE OR REPLACE FUNCTION public.aprobar_remito(p_remito_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_remito public.remitos%ROWTYPE;
  v_permite_neg boolean;
  v_item record;
  v_ant_o numeric(14,2);
  v_nue_o numeric(14,2);
  v_ant_d numeric(14,2);
  v_nue_d numeric(14,2);
  v_n_items integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  PERFORM 1
    FROM public.profiles AS p
   WHERE p.id=v_uid
     AND p.activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El perfil autenticado no existe o está inactivo';
  END IF;

  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id=p_remito_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  IF NOT (
    public.is_admin(v_uid)
    OR public.current_sucursal_id() IS NOT DISTINCT FROM v_remito.sucursal_destino_id
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede aprobar este remito';
  END IF;
  IF v_remito.estado<>'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)',v_remito.numero,v_remito.estado;
  END IF;
  IF v_remito.sucursal_origen_id=v_remito.sucursal_destino_id THEN
    RAISE EXCEPTION 'Origen y destino no pueden coincidir';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_n_items
    FROM public.remito_items AS ri
   WHERE ri.remito_id=p_remito_id;
  IF v_n_items=0 THEN
    RAISE EXCEPTION 'El remito % no tiene ítems',v_remito.numero;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.remito_items AS ri
     WHERE ri.remito_id=p_remito_id
       AND (ri.cantidad IS NULL OR ri.cantidad<=0)
  ) THEN
    RAISE EXCEPTION 'Cantidad inválida en un ítem del remito %',v_remito.numero;
  END IF;

  SELECT COALESCE(s.permitir_stock_negativo,false) INTO v_permite_neg
    FROM public.settings AS s
   WHERE s.id=true;
  v_permite_neg := COALESCE(v_permite_neg,false);

  -- Materializar primero todos los pares y luego bloquearlos por una clave
  -- global (producto, sucursal), independiente de la dirección del remito.
  INSERT INTO public.stock_sucursal(producto_id,sucursal_id,cantidad)
  SELECT ri.producto_id,sid.sucursal_id,0
    FROM public.remito_items AS ri
    CROSS JOIN LATERAL (
      VALUES (v_remito.sucursal_origen_id),(v_remito.sucursal_destino_id)
    ) AS sid(sucursal_id)
   WHERE ri.remito_id=p_remito_id
   ORDER BY ri.producto_id,sid.sucursal_id
  ON CONFLICT (producto_id,sucursal_id) DO NOTHING;

  PERFORM ss.producto_id,ss.sucursal_id
    FROM public.stock_sucursal AS ss
    JOIN public.remito_items AS ri ON ri.producto_id=ss.producto_id
   WHERE ri.remito_id=p_remito_id
     AND ss.sucursal_id IN (
       v_remito.sucursal_origen_id,
       v_remito.sucursal_destino_id
     )
   ORDER BY ss.producto_id,ss.sucursal_id
   FOR UPDATE OF ss;

  FOR v_item IN
    SELECT ri.producto_id,ri.cantidad
      FROM public.remito_items AS ri
     WHERE ri.remito_id=p_remito_id
     ORDER BY ri.producto_id
  LOOP
    IF v_permite_neg THEN
      UPDATE public.stock_sucursal
         SET cantidad=cantidad-v_item.cantidad
       WHERE producto_id=v_item.producto_id
         AND sucursal_id=v_remito.sucursal_origen_id
      RETURNING cantidad+v_item.cantidad,cantidad INTO v_ant_o,v_nue_o;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad=cantidad-v_item.cantidad
       WHERE producto_id=v_item.producto_id
         AND sucursal_id=v_remito.sucursal_origen_id
         AND cantidad>=v_item.cantidad
      RETURNING cantidad+v_item.cantidad,cantidad INTO v_ant_o,v_nue_o;
      IF NOT FOUND THEN
        SELECT COALESCE(ss.cantidad,0) INTO v_ant_o
          FROM public.stock_sucursal AS ss
         WHERE ss.producto_id=v_item.producto_id
           AND ss.sucursal_id=v_remito.sucursal_origen_id;
        RAISE EXCEPTION 'Stock insuficiente en origen para el producto %: hay %, se piden %',
          v_item.producto_id,COALESCE(v_ant_o,0),v_item.cantidad;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      v_item.producto_id,v_remito.sucursal_origen_id,'TRANSFERENCIA_OUT',
      -v_item.cantidad,v_ant_o,v_nue_o,
      'Remito '||v_remito.numero,v_remito.id,v_uid
    );

    UPDATE public.stock_sucursal
       SET cantidad=cantidad+v_item.cantidad
     WHERE producto_id=v_item.producto_id
       AND sucursal_id=v_remito.sucursal_destino_id
    RETURNING cantidad-v_item.cantidad,cantidad INTO v_ant_d,v_nue_d;

    INSERT INTO public.stock_movimientos(
      producto_id,sucursal_id,tipo,cantidad,cantidad_anterior,cantidad_nueva,
      motivo,referencia_id,usuario_id
    ) VALUES (
      v_item.producto_id,v_remito.sucursal_destino_id,'TRANSFERENCIA_IN',
      v_item.cantidad,v_ant_d,v_nue_d,
      'Remito '||v_remito.numero,v_remito.id,v_uid
    );
  END LOOP;

  UPDATE public.remitos
     SET estado='APROBADO',aprobado_por=v_uid,fecha_aprobacion=pg_catalog.now()
   WHERE id=p_remito_id;
END;
$$;

REVOKE ALL ON FUNCTION public.aprobar_remito(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.aprobar_remito(uuid)
  TO authenticated,service_role;

COMMENT ON FUNCTION public.aprobar_remito(uuid) IS
  'Aprueba un remito para un perfil activo y prebloquea stock en orden global para evitar deadlocks inversos.';
