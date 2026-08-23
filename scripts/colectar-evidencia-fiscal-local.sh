#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
umask 077
export LC_ALL=C

for herramienta in docker git jq node shasum supabase; do
  command -v "$herramienta" >/dev/null || {
    echo "Falta la herramienta local requerida: $herramienta" >&2
    exit 1
  }
done

PROJECT_ID="$(sed -n 's/^project_id = "\([^"]*\)"/\1/p' supabase/config.toml)"
if [[ -z "$PROJECT_ID" || ! "$PROJECT_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "No se pudo derivar un project_id local válido desde supabase/config.toml." >&2
  exit 1
fi

# `supabase status` sólo inspecciona el stack local. El JSON contiene claves locales,
# por eso se mantiene en memoria y únicamente se extrae la URL pública para el guard.
STATUS_JSON="$(supabase status -o json 2>/dev/null)" || {
  echo "Supabase local no está iniciado." >&2
  exit 1
}
API_URL="$(jq -er '.API_URL' <<<"$STATUS_JSON")"
API_HOST="$(node -e '
  const u = new URL(process.argv[1]);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) process.exit(2);
  process.stdout.write(u.hostname);
' "$API_URL")" || {
  echo "Guard local: API_URL no apunta a localhost; se rechazó recolectar evidencia." >&2
  exit 1
}
unset STATUS_JSON

DB_CONTAINER="supabase_db_${PROJECT_ID}"
CONTAINER_PROJECT="$(
  docker inspect "$DB_CONTAINER" \
    --format '{{index .Config.Labels "com.supabase.cli.project"}}' 2>/dev/null
)" || {
  echo "No existe el contenedor local derivado: $DB_CONTAINER" >&2
  exit 1
}
if [[ "$CONTAINER_PROJECT" != "$PROJECT_ID" ]]; then
  echo "Guard local: el contenedor no pertenece al project_id de supabase/config.toml." >&2
  exit 1
fi

AUDIT_SQL="scripts/auditar-rollout-fiscal-readonly.sql"
[[ -f "$AUDIT_SQL" ]] || {
  echo "Falta $AUDIT_SQL" >&2
  exit 1
}
MANIFEST_DOC="docs/facturacion-receptor-fiscal-rollout-checklist.md"
[[ -f "$MANIFEST_DOC" ]] || {
  echo "Falta $MANIFEST_DOC" >&2
  exit 1
}

UTC="$(date -u +%Y%m%dT%H%M%SZ)"
HEAD_FULL="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short=12 HEAD)"
EVIDENCE_DIR=".tmp/task14-evidence/${UTC}-${HEAD_SHORT}"
if [[ -e "$EVIDENCE_DIR" ]]; then
  echo "La carpeta de evidencia ya existe: $EVIDENCE_DIR" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"

START_EPOCH="$(date +%s)"

{
  echo "task=Task 14 fiscal local preflight"
  echo "created_at_utc=$UTC"
  echo "repository=$(pwd)"
  echo "head=$HEAD_FULL"
  echo "branch=$(git branch --show-current)"
  echo "supabase_project_id=$PROJECT_ID"
  echo "supabase_api_host=$API_HOST"
  echo "supabase_db_container=$DB_CONTAINER"
  echo "environment_names=NODE_ENV,INVOICING_MOCK_TEST_RUNNER,INVOICING_MOCK_MODE,INVOICING_MOCK_SCENARIO"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "supabase=$(supabase --version)"
  echo "postgres=$(docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -Atc 'show server_version')"
} >"$EVIDENCE_DIR/metadata.txt"

git status --short >"$EVIDENCE_DIR/git-status.txt"
git diff --check >"$EVIDENCE_DIR/git-diff-check.txt"

find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  >"$EVIDENCE_DIR/migrations-all.sha256"

find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print \
  | sed 's#^supabase/migrations/##' \
  | awk '$0 >= "20260822133249"' \
  | sort \
  >"$EVIDENCE_DIR/task14-migrations-files.txt"

while IFS= read -r migration; do
  shasum -a 256 "supabase/migrations/$migration"
done <"$EVIDENCE_DIR/task14-migrations-files.txt" \
  >"$EVIDENCE_DIR/task14-manifest-actual.sha256"

awk -F'`' '
  /^\|[[:space:]]*[0-9]+[[:space:]]*\|/ && length($2)>4 && length($4)==64 {
    print $4 "  supabase/migrations/" $2
  }
' "$MANIFEST_DOC" >"$EVIDENCE_DIR/task14-manifest-documented.sha256"

if ! diff -u \
  "$EVIDENCE_DIR/task14-manifest-documented.sha256" \
  "$EVIDENCE_DIR/task14-manifest-actual.sha256" \
  >"$EVIDENCE_DIR/task14-manifest-diff.txt"; then
  echo "El manifiesto SHA-256 documentado no coincide con los archivos Task 14." >&2
  exit 1
fi

docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres \
  --no-psqlrc --set ON_ERROR_STOP=1 -Atc \
  "select version||'_'||name||'.sql'
     from supabase_migrations.schema_migrations
    where version>='20260822133249'
    order by version" \
  >"$EVIDENCE_DIR/task14-migrations-ledger.txt"

if ! diff -u \
  "$EVIDENCE_DIR/task14-migrations-files.txt" \
  "$EVIDENCE_DIR/task14-migrations-ledger.txt" \
  >"$EVIDENCE_DIR/task14-migrations-diff.txt"; then
  echo "El ledger local no coincide con los archivos Task 14. Ejecutá un reset local antes de recolectar." >&2
  exit 1
fi

supabase migration list --local >"$EVIDENCE_DIR/migration-list-local.txt"

{
  echo "scope=local-only"
  echo "schema_verified_by=$AUDIT_SQL"
  echo "ledger_verified_by=task14-migrations-files.txt vs task14-migrations-ledger.txt"
  echo "linked_repair_executed=false"
  echo "linked_repair_instruction=supabase migration repair --status applied <VERSION> --linked"
  echo "linked_list_required_before_rollout=true"
} >"$EVIDENCE_DIR/schema-vs-ledger.txt"

docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres \
  --no-psqlrc --set ON_ERROR_STOP=1 --file=- \
  <"$AUDIT_SQL" \
  >"$EVIDENCE_DIR/auditoria-readonly.txt"

# Sólo se guardan rutas candidatas, nunca el contenido encontrado.
git ls-files \
  | awk '
      /(^|\/)\.env($|\.)/ && $0 !~ /\.env\.example$/ { print; next }
      tolower($0) ~ /\.(crt|cer|key|csr|p12|pfx|pem)$/ { print }
    ' \
  >"$EVIDENCE_DIR/forbidden-tracked-paths.txt"

git grep -I -l -E \
  'BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY|BEGIN CERTIFICATE|<([[:alnum:]_-]+:)?Envelope|ticket[^[:alnum:]]*(storage|token)|SOAP[^[:alnum:]]*(request|response)' \
  -- ':!package-lock.json' ':!bun.lock' \
  >"$EVIDENCE_DIR/sensitive-content-candidate-paths.txt" || true

: >"$EVIDENCE_DIR/generated-sensitive-paths.txt"
: >"$EVIDENCE_DIR/generated-content-candidate-paths.txt"
for generated_dir in .vercel .output dist playwright-report test-results; do
  [[ -d "$generated_dir" ]] || continue
  find "$generated_dir" -type f \
    \( -name '.env' -o -name '.env.*' -o -iname '*.crt' -o -iname '*.cer' \
       -o -iname '*.key' -o -iname '*.csr' -o -iname '*.p12' -o -iname '*.pfx' \
       -o -iname '*.pem' \) \
    -print >>"$EVIDENCE_DIR/generated-sensitive-paths.txt"
  find "$generated_dir" -type f -size -5M -print0 \
    | xargs -0 grep -I -l -E \
      'BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY|BEGIN CERTIFICATE|<([[:alnum:]_-]+:)?Envelope|ticket[^[:alnum:]]*(storage|token)|SOAP[^[:alnum:]]*(request|response)' \
      >>"$EVIDENCE_DIR/generated-content-candidate-paths.txt" || true
done

{
  echo "Scripts del gate Task 14 que deben derivar project_id/contenedor:"
  for script in \
    scripts/test-receptor-fiscal-schema.sh \
    scripts/test-fiscal-concurrencia.sh \
    scripts/test-venta-fiscal-atomica.sh \
    scripts/test-facturacion-multiemisor.sh \
    scripts/test-venta-contado.sh \
    scripts/test-nota-credito-sin-factura.sh \
    scripts/test-caja-y-saldos.sh \
    scripts/test-crear-remito-atomico.sh \
    scripts/test-remitos-acl.sh \
    scripts/test-remitos-concurrencia.sh \
    scripts/test-perfiles-inactivos-rpc.sh \
    scripts/test-conflictos-emision-rest.sh \
    scripts/test-notas-v2-rest.sh \
    scripts/test-notas-v2-scope.sh \
    scripts/test-venta-idempotencia-autorizacion.sh \
    scripts/test-liberar-claim-fiscal.sh; do
    if [[ ! -f "$script" ]]; then
      echo "MISSING $script"
      exit 1
    fi
    if rg -q 'supabase_db_local' "$script"; then
      echo "HARDCODED $script"
      exit 1
    fi
    if ! rg -q 'project_id.*supabase/config\.toml' "$script"; then
      echo "NOT_DERIVED $script"
      exit 1
    fi
    echo "OK $script"
  done
} >"$EVIDENCE_DIR/local-db-derivation.txt"

END_EPOCH="$(date +%s)"
{
  echo "cwd=$(pwd)"
  echo "commands=git status --short; git diff --check; shasum -a 256 + manifest cmp; supabase migration list --local; local ledger diff; docker psql READ ONLY schema+ledger audit; tracked/generated path/content-candidate scan"
  echo "environment_values_recorded=false"
  echo "external_network_used=false"
  echo "exit=0"
  echo "duration_seconds=$((END_EPOCH - START_EPOCH))"
} >"$EVIDENCE_DIR/run.txt"

find "$EVIDENCE_DIR" -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  >"$EVIDENCE_DIR/SHA256SUMS"

echo "Evidencia local guardada en $EVIDENCE_DIR"
