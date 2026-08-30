#!/usr/bin/env bash
set -euo pipefail

if [[ "${NODE_ENV:-}" != "test" || \
      "${INVOICING_MOCK_TEST_RUNNER:-}" != "playwright" || \
      "${INVOICING_MOCK_MODE:-}" != "true" ]]; then
  echo "El entrypoint E2E exige NODE_ENV=test, runner Playwright y mock fiscal activo." >&2
  exit 1
fi

case "${INVOICING_MOCK_SCENARIO:-}" in
  OK|CAIDA_PRE_REQUEST|RECHAZO_DEFINITIVO|TIMEOUT_POST_REQUEST|QR_ERROR) ;;
  *) echo "El entrypoint E2E recibió un escenario fiscal inválido." >&2; exit 1 ;;
esac

if ! estado_local="$(supabase status -o env 2>/dev/null)"; then
  echo "No se pudo leer el estado de Supabase local; ejecutá supabase start." >&2
  exit 1
fi

valor_estado() {
  local nombre="$1"
  printf '%s\n' "$estado_local" | sed -n "s/^${nombre}=\"\(.*\)\"$/\1/p" | head -n 1
}

api_url="$(valor_estado API_URL)"
anon_key="$(valor_estado ANON_KEY)"
service_role_key="$(valor_estado SERVICE_ROLE_KEY)"

case "$api_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "El entrypoint E2E se negó a usar un Supabase que no es local." >&2; exit 1 ;;
esac
if [[ -z "$anon_key" || -z "$service_role_key" ]]; then
  echo "Supabase local no informó anon key y service-role para E2E." >&2
  exit 1
fi

export SUPABASE_URL="$api_url"
export VITE_SUPABASE_URL="$api_url"
export SUPABASE_PUBLISHABLE_KEY="$anon_key"
export VITE_SUPABASE_PUBLISHABLE_KEY="$anon_key"
export SUPABASE_ANON_KEY="$anon_key"
export SUPABASE_SERVICE_ROLE_KEY="$service_role_key"

exec ./node_modules/.bin/playwright test "$@"
