# SDD ledger — plan: docs/superpowers/plans/2026-08-30-presupuesto-consumidor-final-descripcion-color.md

Workspace: `/private/tmp/quimex-presupuesto-color.N9cBhs`
Branch: `feat/presupuesto-consumidor-color`
Implementation base: `b6a70ae`
Integrated parent fiscal head: `ad9cf31` (merge `c9a5ee9`)
Spec: `docs/superpowers/specs/2026-08-30-presupuesto-consumidor-final-descripcion-color-design.md`
Baseline: `npx vitest run src/lib/ventas.functions.test.ts src/routes/_authenticated/ventas.nueva.test.ts src/lib/presupuesto-pdf.test.ts` — 3 files, 22 tests passed.
Environment: this isolated worktree reuses the dependency directory from `/private/tmp/quimex-cierre-fiscal.vQKiY2`; database tests remain sequential to avoid sharing local Supabase state with the final fiscal reviewer.

## Pre-flight self-consistency scan

| Task | Produces/tests | Consumes/implementation | Finding |
|---|---|---|---|
| 1 | normalizer + SQL description writers | pure TS contract; current effective budget/sale writers | Consistent; description changes no price/IVA/stock inputs. |
| 2 | generic/cash conversion RPC | Task 1 frozen budget descriptions | Consistent; copied descriptions precede RPC return/API work. |
| 3 | schemas, preflight, generated types | Tasks 1–2 SQL contracts | Consistent; types regenerate once after both migrations. |
| 4 | direct-sale/budget editors and print regressions | Tasks 1 and 3 contracts | Consistent; UI sends description but server remains authoritative. |
| 5 | conversion dialog, E2E and runbook | Tasks 2–4 complete flow | Consistent; browser uses server-resolved client and DB-revalidated cash. |

## Pre-flight shared-file/interface scan

| Tasks | Producer → consumer | Finding |
|---|---|---|
| 1 → 2 | `presupuesto_items.descripcion` → converted `venta_items.descripcion` | Ordered correctly. |
| 1 → 3/4 | `normalizarDescripcionItem` → server schemas and inputs | Stable name/signature declared in spec/plan. |
| 2 → 3 | RPC adds effective `cliente_id` → `normalizarConversion` | Exact return contract is declared before generated types. |
| 2 → 5 | caja/sucursal enforcement → dialog preflight and E2E | UI is advisory; transaction remains authoritative. |
| 3 → 5 | `preflightConversionPresupuesto` → dialog | Closed DTO and auth-first boundary precede UI. |
| 4 ↔ 5 | `presupuestos.$id.tsx` | Intentional staged edit: Task 4 description/detail, Task 5 dialog wiring. No parallel implementers. |
| 3 ↔ 4 | `ventas.functions.ts` / route payload | Server contract lands before UI sends description. |

Pre-flight result: no unresolved contradiction. Decisions locked: global generic candidate, strict pre-opened cash, 160-character custom description, V2-only anonymous conversion.

## Task progress

- Task 1 — implementación completa; revisión pendiente.
  - RED TypeScript observado: `npx vitest run src/lib/item-descripcion.test.ts`
    falló porque `./item-descripcion` todavía no existía.
  - RED SQL observado: `bash scripts/test-descripcion-personalizada-items.sh`
    falló al persistir el nombre del catálogo en `crear_presupuesto`.
  - Se agregó el contrato puro de 160 caracteres y la migración redefine sólo
    `crear_presupuesto`, `editar_presupuesto` y `_crear_venta_core_20260823`.
  - GREEN local: descripción SQL, edición (19/19), venta fiscal atómica y
    normalizador TypeScript (2/2).
  - Checks focales: Bash parse, Prettier, ESLint, TypeScript y `git diff --check`
    en verde. Advisors conserva sólo warnings históricos ajenos a Task 1.
  - `supabase db lint` sigue señalando el error histórico de
    `cambiar_precios_masivo` sobre la tabla temporal `_objetivo`; no reporta
    errores en las funciones de Task 1.
  - Commit: `80cb0ba` (`feat(ventas): congelar descripción personalizada`).
- Task 1 review round 1 (`80cb0ba`): `Spec: FAIL`, `Quality: FAIL`; sin
  críticos. Important: TypeScript (`trim`/`\s`) y PostgreSQL (`[[:space:]]`)
  clasificaban distinto U+FEFF y U+0085.
- Task 1 fix round 1: implementación completa; revisión del fix pendiente.
  - RED TypeScript observado en los dos casos de U+0085; contrato TypeScript
    corregido con una clase Unicode cerrada común y GREEN 10/10.
  - RED SQL focal observado cargando únicamente la definición anterior del
    helper: `bash scripts/test-descripcion-personalizada-items.sh` salió 3 en
    `SQL colapsa y recorta U+FEFF, U+0085 y NBSP con la misma frontera explícita`.
    El script revirtió sus fixtures y no se alteró la historia de migraciones.
  - Migración corregida con la misma clase explícita y orden collapse-then-trim;
    agrega regresiones transaccionales para U+FEFF, U+0085, NBSP y límites de
    160/161 emoji.
  - Tras integrar el head fiscal revisado `ad9cf31` mediante el merge normal
    `c9a5ee9`, `npx supabase db reset --local` aplicó desde cero las migraciones
    151434, 151440 y 154723.
  - GREEN SQL completo: descripción personalizada, edición (19/19) y venta
    fiscal atómica, incluidas sus pruebas de concurrencia.
  - Checks no-DB en verde: Bash parse, Prettier focal TypeScript, ESLint focal,
    TypeScript, Vitest focal (10/10) y `git diff --check`.
  - `supabase migration list --local` muestra historia local alineada hasta
    20260830154723. `supabase db lint` conserva únicamente el error histórico de
    `cambiar_precios_masivo` sobre `_objetivo`; advisors conserva deuda histórica,
    incluidos los errores de vistas SECURITY DEFINER `fiscal_config_publica` y
    `cuenta_corriente_saldos`, sin hallazgos sobre el helper de Task 1.
- Task 1 complete (`80cb0ba..b775acd`). Independent re-review: `Spec: PASS`,
  `Quality: PASS`; no Critical, Important or Minor findings. Unicode parity is
  fixed and transactionally tested, and Task 2 remains untouched.
