# Desarrollo local — PinturaGest / Quimex

Guía para levantar el proyecto en tu propia máquina y hacer cambios. **No hace
falta ninguna credencial de producción**: todo corre contra una base local de
prueba. A los datos reales del negocio solo se llega con la app ya desplegada
(https://quimex-pinturagest.vercel.app), nunca desde el entorno de desarrollo.

> ⚠️ **Nunca uses el `.env` de producción para desarrollar.** Ese archivo tiene la
> `SUPABASE_SERVICE_ROLE_KEY` (acceso total a la base real) y la
> `ARCA_ENCRYPTION_KEY` (facturación AFIP). No se comparten. Las claves *locales*
> que usás acá son claves demo estándar de Supabase, no secretas.

## 1. Requisitos

- [Docker Desktop](https://www.docker.com/) (Supabase local corre en containers)
- [Bun](https://bun.sh/) (`curl -fsSL https://bun.sh/install | bash`)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase` en Mac)

## 2. Clonar e instalar

```bash
git clone https://github.com/MaitenaWeller20/pintura-hub-pro.git
cd pintura-hub-pro
bun install
```

## 3. Levantar la base local

```bash
supabase start        # arranca Supabase local (tarda un poco la primera vez)
supabase db reset     # aplica TODAS las migraciones (crea el esquema y las 2 sucursales)
```

`supabase start` imprime al final las credenciales locales. Anotá el **API URL**,
el **anon key** (o `publishable key`) y el **service_role key** (o `secret key`) —
los necesitás para el `.env`.

## 4. Crear el `.env` local

Copiá el template y completalo con lo que imprimió `supabase start`:

```bash
cp .env.example .env
```

Dejá el `.env` así (reemplazá los `<...>` con los valores de `supabase start`):

```bash
SUPABASE_URL="http://127.0.0.1:54321"
SUPABASE_PUBLISHABLE_KEY="<anon / publishable key local>"
SUPABASE_SERVICE_ROLE_KEY="<service_role / secret key local>"

VITE_SUPABASE_URL="http://127.0.0.1:54321"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon / publishable key local>"

# Facturación en modo simulado: genera un CAE falso y NO llama a AFIP.
# Así el circuito de venta/factura funciona sin certificados reales.
INVOICING_MOCK_MODE="true"
# Para local alcanza cualquier texto de 32+ caracteres (solo cifra datos de prueba).
ARCA_ENCRYPTION_KEY="clave-local-de-desarrollo-cualquiera-de-32+"
```

## 5. Crear un usuario para loguearte

La base local arranca sin usuarios. Creá uno admin con el script incluido:

```bash
./scripts/crear-admin-local.sh                          # admin@local.test / admin1234
# o con tus datos:
./scripts/crear-admin-local.sh mi@mail.com miClave123 "Mi Nombre"
```

## 6. Levantar la app

```bash
bun run dev           # http://localhost:8080
```

Entrá con el usuario del paso 5. ¡Listo para desarrollar!

## Flujo de trabajo

- **Código** (UI, lógica): editás los archivos en `src/` y el navegador recarga solo.
- **Cambios en la base** (tablas, funciones, RPC): se hacen con **migraciones**, no
  tocando la base a mano. Creá un archivo nuevo en `supabase/migrations/` con el
  formato `AAAAMMDDHHMMSS_descripcion.sql` y aplicá con `supabase db reset` (o
  `supabase migration up`). Así el cambio queda versionado y se puede llevar a
  producción después.
- **Antes de commitear**: `bun run typecheck` y `bun run test` tienen que pasar.
- **Compartir cambios**: commit + push a una rama y PR (no pushear directo a `main`).
- **Deploy a producción**: lo hace quien tenga acceso a la cuenta de prod
  (migraciones con `supabase db push --linked` + `vercel --prod`). Desde local
  nunca se toca producción.

## Comandos útiles

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor de desarrollo en :8080 |
| `bun run typecheck` | Chequeo de tipos (TS) |
| `bun run test` | Tests (vitest) |
| `bun run build` | Build de producción (para validar antes de deploy) |
| `supabase db reset` | Recrea la base local desde las migraciones |
| `supabase stop` | Apaga la base local |
