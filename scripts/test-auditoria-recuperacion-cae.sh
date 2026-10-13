#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fixture="$(mktemp)"
log="$(mktemp)"
cleanup() {
  rm -f -- "$fixture" "$log"
}
trap cleanup EXIT

if ! T11_AUDIT_FIXTURE_OUTPUT="$fixture" \
  bash scripts/test-nota-credito-periodo-fiscal.sh >"$log" 2>&1; then
  sed -n '1,240p' "$log" >&2
  exit 1
fi
T11_AUDIT_FIXTURE="$fixture" ./node_modules/.bin/tsx scripts/test-auditoria-recuperacion-cae.ts
