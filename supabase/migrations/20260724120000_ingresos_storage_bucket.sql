-- ============================================================
-- Bucket privado para los archivos originales de los remitos.
--
-- Guarda el PDF/foto que subió la usuaria: sirve de respaldo y permite re-procesar
-- una extracción que salió mal. Privado: sólo se lee con credenciales del server.
-- El path lo arma el server como <sucursal_id>/<ingreso_id>/<archivo>, y las
-- políticas restringen el acceso a la sucursal del usuario (o admin).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'remitos-proveedor', 'remitos-proveedor', false,
  10485760,  -- 10 MB (el request a Anthropic tope 32MB; base64 infla ~33%)
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- El primer segmento del path es el sucursal_id. Un usuario ve/escribe los de su
-- sucursal; un admin, todos. Mismo criterio que la RLS de las tablas.
DROP POLICY IF EXISTS "remitos_prov leer" ON storage.objects;
CREATE POLICY "remitos_prov leer" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'remitos-proveedor'
    AND (public.is_admin(auth.uid()) OR (storage.foldername(name))[1] = public.current_sucursal_id()::text)
  );

DROP POLICY IF EXISTS "remitos_prov subir" ON storage.objects;
CREATE POLICY "remitos_prov subir" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'remitos-proveedor'
    AND (public.is_admin(auth.uid()) OR (storage.foldername(name))[1] = public.current_sucursal_id()::text)
  );
