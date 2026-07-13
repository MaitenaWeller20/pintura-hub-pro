-- ============================================================
-- Alta de usuarios: username derivado del email podía colisionar
--
-- El trigger handle_new_user() arma el username con la parte del email anterior
-- al @, y profiles.username es UNIQUE. Así que dar de alta a juan@empresa.com y
-- después a juan@gmail.com hacía explotar el INSERT: el trigger levantaba una
-- violación de unicidad y Supabase Auth devolvía un 500 sin ningún mensaje útil.
-- Desde el panel se veía como "no se pudo crear el usuario" y nada más.
--
-- Ahora, si el username ya está tomado, se le agrega un sufijo numérico.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_base  text;
  v_user  text;
  v_n     integer := 1;
BEGIN
  v_base := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'username', ''),
    split_part(NEW.email, '@', 1),
    'usuario'
  );
  v_user := v_base;

  -- Si está tomado, probamos base2, base3, ... hasta encontrar uno libre.
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_user) LOOP
    v_n := v_n + 1;
    v_user := v_base || v_n::text;
  END LOOP;

  INSERT INTO public.profiles (id, username, nombre_completo)
  VALUES (
    NEW.id,
    v_user,
    COALESCE(NEW.raw_user_meta_data->>'nombre_completo', '')
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END; $$;
