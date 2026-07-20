#!/usr/bin/env bash
# ============================================================
# Crea un usuario ADMIN en la base LOCAL de Supabase (desarrollo).
#
# Úsalo después de `supabase start` + `supabase db reset`, cuando la base local
# todavía no tiene ningún usuario para loguearte. NO toca producción: usa las
# credenciales locales del .env (SUPABASE_URL apuntando a 127.0.0.1 y el
# service_role key LOCAL, que es una clave demo, no un secreto).
#
# Uso:
#   ./scripts/crear-admin-local.sh                          # admin@local.test / admin1234
#   ./scripts/crear-admin-local.sh mi@mail.com miClave123   # email y clave a medida
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-admin@local.test}"
PASSWORD="${2:-admin1234}"
NOMBRE="${3:-Admin Local}"

# Cargar el .env local (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY locales).
[ -f .env ] || { echo "❌ No hay .env. Copiá .env.example a .env y completá las claves LOCALES (las imprime 'supabase start')."; exit 1; }
set -a; source .env; set +a
: "${SUPABASE_URL:?Falta SUPABASE_URL en .env}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Falta SUPABASE_SERVICE_ROLE_KEY en .env}"

case "$SUPABASE_URL" in
  *127.0.0.1*|*localhost*) : ;;
  *) echo "❌ SUPABASE_URL ($SUPABASE_URL) no apunta a local. Este script es SOLO para la base local."; exit 1;;
esac

EMAIL="$EMAIL" PASSWORD="$PASSWORD" NOMBRE="$NOMBRE" python3 - <<'PY'
import json, os, urllib.request, urllib.error
U = os.environ["SUPABASE_URL"].rstrip("/")
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EMAIL, PASSWORD, NOMBRE = os.environ["EMAIL"], os.environ["PASSWORD"], os.environ["NOMBRE"]
H = {"apikey": K, "Authorization": "Bearer " + K, "Content-Type": "application/json"}

def call(method, path, body=None, extra=None):
    h = dict(H); h.update(extra or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(U + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"❌ {method} {path} -> {e.code}: {e.read().decode()[:300]}")

# 1) Crear el usuario en auth (email ya confirmado, para poder loguear de una).
user = call("POST", "/auth/v1/admin/users",
            {"email": EMAIL, "password": PASSWORD, "email_confirm": True})
uid = user["id"]
print(f"✓ Usuario auth creado: {EMAIL}  (id {uid[:8]}…)")

# 2) Sucursal por defecto (O'Higgins) para el profile.
suc = call("GET", "/rest/v1/sucursales?codigo=eq.OHIGGINS&select=id")
if not suc:
    raise SystemExit("❌ No hay sucursales. Corré 'supabase db reset' primero (las crea la migración base).")
suc_id = suc[0]["id"]

# 3) Profile + rol admin (el service_role key saltea RLS).
call("POST", "/rest/v1/profiles",
     {"id": uid, "username": EMAIL.split("@")[0], "nombre_completo": NOMBRE,
      "sucursal_id": suc_id, "activo": True},
     extra={"Prefer": "resolution=merge-duplicates"})
call("POST", "/rest/v1/user_roles",
     {"user_id": uid, "role": "admin"},
     extra={"Prefer": "resolution=merge-duplicates"})

print(f"✓ Profile + rol admin listos.")
print(f"\n🎉 Ya podés entrar en http://localhost:8080 con:")
print(f"   email:    {EMAIL}")
print(f"   password: {PASSWORD}")
PY
