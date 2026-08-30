# SDD ledger — plan: docs/superpowers/plans/2026-08-30-presupuesto-consumidor-final-descripcion-color.md

Workspace: `/private/tmp/quimex-presupuesto-color.N9cBhs`
Branch: `feat/presupuesto-consumidor-color`
Implementation base: `b6a70ae`
Integrated parent fiscal head: `ad9cf31` (merge `c9a5ee9`)
Spec: `docs/superpowers/specs/2026-08-30-presupuesto-consumidor-final-descripcion-color-design.md`
Baseline: `npx vitest run src/lib/ventas.functions.test.ts src/routes/_authenticated/ventas.nueva.test.ts src/lib/presupuesto-pdf.test.ts` — 3 files, 22 tests passed.
Environment: this isolated worktree reuses the dependency directory from `/private/tmp/quimex-cierre-fiscal.vQKiY2`; database tests remain sequential to avoid sharing local Supabase state with the final fiscal reviewer.

## Pre-flight self-consistency scan

| Task | Produces/tests                                   | Consumes/implementation                                 | Finding                                                                  |
| ---- | ------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | normalizer + SQL description writers             | pure TS contract; current effective budget/sale writers | Consistent; description changes no price/IVA/stock inputs.               |
| 2    | generic/cash conversion RPC                      | Task 1 frozen budget descriptions                       | Consistent; copied descriptions precede RPC return/API work.             |
| 3    | schemas, preflight, generated types              | Tasks 1–2 SQL contracts                                 | Consistent; types regenerate once after both migrations.                 |
| 4    | direct-sale/budget editors and print regressions | Tasks 1 and 3 contracts                                 | Consistent; UI sends description but server remains authoritative.       |
| 5    | conversion dialog, E2E and runbook               | Tasks 2–4 complete flow                                 | Consistent; browser uses server-resolved client and DB-revalidated cash. |

## Pre-flight shared-file/interface scan

| Tasks   | Producer → consumer                                                   | Finding                                                                                             |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 → 2   | `presupuesto_items.descripcion` → converted `venta_items.descripcion` | Ordered correctly.                                                                                  |
| 1 → 3/4 | `normalizarDescripcionItem` → server schemas and inputs               | Stable name/signature declared in spec/plan.                                                        |
| 2 → 3   | RPC adds effective `cliente_id` → `normalizarConversion`              | Exact return contract is declared before generated types.                                           |
| 2 → 5   | caja/sucursal enforcement → dialog preflight and E2E                  | UI is advisory; transaction remains authoritative.                                                  |
| 3 → 5   | `preflightConversionPresupuesto` → dialog                             | Closed DTO and auth-first boundary precede UI.                                                      |
| 4 ↔ 5   | `presupuestos.$id.tsx`                                                | Intentional staged edit: Task 4 description/detail, Task 5 dialog wiring. No parallel implementers. |
| 3 ↔ 4   | `ventas.functions.ts` / route payload                                 | Server contract lands before UI sends description.                                                  |

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
  - `supabase migration list --local` muestra historia local alineada hasta 20260830154723. `supabase db lint` conserva únicamente el error histórico de
    `cambiar_precios_masivo` sobre `_objetivo`; advisors conserva deuda histórica,
    incluidos los errores de vistas SECURITY DEFINER `fiscal_config_publica` y
    `cuenta_corriente_saldos`, sin hallazgos sobre el helper de Task 1.
- Task 1 complete (`80cb0ba..b775acd`). Independent re-review: `Spec: PASS`,
  `Quality: PASS`; no Critical, Important or Minor findings. Unicode parity is
  fixed and transactionally tested, and Task 2 remains untouched.
- Task 2 — implementación completa; revisión independiente pendiente.
  - Se inspeccionaron las definiciones efectivas de
    `convertir_presupuesto_en_venta_neutral`, `crear_venta`,
    `_crear_venta_core_20260823`, `caja_sesion_actual`, `cerrar_caja`, sus
    triggers, locks, RLS y grants antes de copiar la lineage vigente.
  - RED observado: `bash scripts/test-presupuesto-consumidor-final-caja.sh`
    salió 3 en la primera conversión anónima con
    `Para convertir un presupuesto hay que elegir el cliente`.
  - La migración agrega la unicidad parcial exacta del Consumidor Final global,
    `presupuestos.conversion_payload_hash` y recrea sólo la RPC v2 con receptor
    efectivo, autorización BOLA opaca, caja preexistente y descripción
    congelada. El escritor legacy sigue retirado y el core/normalizador siguen
    owner-only.
  - Primer GREEN detectó una diferencia real entre la serialización JSONB de
    `121` y `121.00`; la huella ahora aplica `trim_scale` al monto y la regresión
    confirma que ambos son el mismo replay canónico.
  - `npx supabase db reset --local` aplicó desde cero toda la historia hasta
    `20260830154723`; `supabase migration list --local` quedó alineado.
  - GREEN focal: candidato exacto/ausente/ambiguo, anónimo contado, rechazo de
    CTA_CTE anónima y UUID genérico, preservación de cliente NULL y descripción,
    sucursal/caja para admin y empleado real `authenticated`, replay/conflictos,
    BOLA, grants/owner/search_path y cleanup sin residuos.
  - La carrera real cierre-vs-conversión confirma que, si el cierre gana
    `FOR UPDATE`, la conversión espera, falla por caja cerrada y no autoabre otra
    sesión ni deja venta/presupuesto mutados.
  - Regresiones GREEN: `scripts/test-venta-fiscal-atomica.sh`, descripción
    personalizada y edición de presupuesto (19/19). Bash parse, TypeScript y
    `git diff --check` también pasan.
  - `supabase db lint` conserva únicamente el error histórico de
    `cambiar_precios_masivo` sobre `_objetivo`; advisors conserva los avisos
    históricos de RLS/vistas/funciones y no señala objetos de Task 2.
  - No se usaron proyecto remoto, `--linked`, `db push`, certificados ni ARCA.
- Task 2 review round 1 (`6c7e49b`): `Spec: FAIL`, `Quality: FAIL`; sin
  Critical ni Minor. Dos Important: `FOR KEY SHARE` permitía cambiar la
  elegibilidad del receptor durante la conversión y el orden caja→productos se
  invertía respecto de venta directa productos→caja, habilitando un deadlock.
- Task 2 fix round 1: implementación completa; revisión del fix pendiente.
  - RED de receptor observado: con la conversión anónima detenida después de
    elegir candidato, `es_generico=false` se adelantó y el focal salió 1. La
    regresión final cubre en un UPDATE `es_generico`, `tipo`,
    `sucursal_habitual_id`, `es_obra` y `activo`; para cliente identificado
    cubre `es_generico` y `activo`.
  - RED de orden observado después del primer fix: venta directa sostuvo el
    producto y esperó el advisory de caja mientras conversión sostuvo caja y
    esperó producto. PostgreSQL devolvió `deadlock detected` y el focal salió 1.
  - Ambos selectores usan ahora el lock mínimo compatible `FOR SHARE`. La caja
    se prevalida después de bloquear/construir ítems y justo antes de
    `crear_venta`, alineando productos→caja sin mutaciones comerciales previas.
  - GREEN focal: ambos receptores permanecen elegibles; venta directa y
    conversión terminan sin deadlock, usan la única caja preabierta, no dejan
    huérfanos ni autoapertura y descuentan stock una vez por operación. La
    carrera cierre-vs-conversión original sigue pasando.
  - `npx supabase db reset --local` reaplicó toda la historia y los gates GREEN
    incluyen focal/concurrencia, venta fiscal atómica, descripción personalizada
    y edición de presupuesto (19/19). TypeScript, Bash parse y `git diff --check`
    pasan; el lint de DB conserva sólo `_objetivo` histórico.
  - Prettier conserva warnings previos en las tablas Markdown del ledger; su
    diff propuesto no incluye el bloque de evidencia agregado en este fix.
  - Cleanup final: cero sesiones `t2_%`, cero fixtures, hook de prueba ausente y
    flags restaurados. No se usaron remoto, `--linked`, `db push` ni ARCA.
- Task 2 review round 2 (`6cd9080`): los dos fixes productivos fueron validados,
  pero `Spec: FAIL` y `Quality: FAIL` por un Important del harness. Cuatro
  workers exitosos confirmaban ventas/conversiones y el cleanup no podía
  restaurar con seguridad el contador compartido de comprobantes.
- Task 2 fix round 2: implementación completa; revisión del fix pendiente.
  - Tras un reset local, el RED canónico observó
    `comprobante_secuencias: [] → OHIGGINS/VENTA/4` y el focal salió 1.
  - Los cuatro workers que numeran ahora comprueban receptor, caja, presupuesto,
    stock y aislamiento dentro de su propia sesión y terminan en `ROLLBACK`.
    El harness no decrementa ni restaura manualmente numeración compartida.
  - Dos ejecuciones focales consecutivas salieron 0; el snapshot completo del
    contador fue `[]` antes, después de la primera y después de la segunda.
    Ambas carreras conservan su sincronización real y no dejan efectos
    comerciales persistentes.
  - El gate de venta fiscal atómica, TypeScript, Bash parse, `git diff --check`
    y el lint local pasan; este último conserva sólo `_objetivo` histórico. Un
    reset final seguido por un tercer focal dejó nuevamente contador `[]`, cero
    fixtures/sesiones y ningún hook de prueba.
- Task 2 complete (`24c7bc5..48267ae`). Independent re-review: `Spec: PASS`,
  `Quality: PASS`; no Critical, Important or Minor findings. All four
  number-generating workers assert inside their transactions and roll back;
  the full numbering snapshot remains unchanged and the production migration
  is ready for the server-contract layer.
- Task 3 — implementación completa; revisión independiente pendiente.
  - RED de contratos observado: V2 rechazaba `cliente_id: null`, la descripción
    de venta quedaba cruda y se aceptaban vacío/161 caracteres. Tras el primer
    GREEN, el RED de resultado mostró que `normalizarConversion` descartaba el
    `cliente_id` efectivo; el RED fiscal rechazó `descripcion` como clave no
    reconocida y el preflight aún no existía.
  - V2 exige la propiedad `cliente_id` y admite `null`; legacy exige UUID. El
    resultado exige el `cliente_id` autoritativo de PostgreSQL y lo proyecta
    como `clienteId`. Venta directa y borrador fiscal normalizan sólo una
    descripción presente con el contrato común de 160 code points, sin tocar
    cantidad, descuento, precio ni IVA; omitirla conserva compatibilidad.
  - El preflight usa exclusivamente el cliente Supabase autenticado y RLS:
    presupuesto primero, luego hasta dos cajas de su sucursal. Inexistente y
    fuera de alcance comparten error opaco, no hay fallback privilegiado, dos
    cajas fallan cerrado y la salida omite saldos, movimientos y otros campos.
    Cero cajas se representa como `caja: null` para que la UI informe y bloquee.
  - `npx supabase db reset --local` reaplicó la historia completa hasta
    `20260830154723`. Los tipos se regeneraron una vez desde local y coinciden
    byte a byte con el CLI tras la única normalización permitida de EOF.
  - GREEN: focal de Task 3 y fiscal (71/71), suite Vitest completa (82 archivos
    pasaron, 2 omitidos; 1760 tests pasaron, 22 omitidos), TypeScript, ESLint
    focal, Prettier focal y `git diff --check`.
  - Regresiones SQL GREEN: conversión anónima/caja/concurrencia, descripción
    personalizada y venta fiscal atómica. `supabase migration list --local`
    quedó alineado; `db lint` conserva sólo `_objetivo` histórico y advisors
    conserva deuda histórica de RLS/vistas sin hallazgos sobre Task 3.
  - No se usaron proyecto remoto, `--linked`, `db push`, ARCA ni certificados.
- Task 3 complete (`527a729..4171d5c`). Independent review: `Spec: PASS`,
  `Quality: PASS`; no Critical, Important or Minor findings. The authenticated
  preflight, closed DTO, effective receiver result, shared description contract
  and regenerated local types are approved for the UI tasks.
- Task 4 — implementación completa; revisión independiente pendiente.
  - RED UI observado: la ruta montada de venta directa agregó P-1 pero no
    exponía `Descripción de P-1`; el focal falló por ese selector ausente.
  - GREEN: venta directa usa el contrato común de 160 caracteres, ayuda visible
    asociada y un único adaptador que persiste la descripción; NC heredada queda
    readonly. Alta/edición de presupuesto inicializan y conservan `descripcion`
    desde catálogo/snapshot, y la grilla/detalle muestran ese texto sin tocar
    precio, IVA, descuento, cantidad, stock, catálogo ni límites fiscales.
  - Las regresiones de PDF de presupuesto, comprobante/snapshot, ticket y NC
    usan `Base 10 L (Código 1234)`. La reimpresión fiscal afirma que el snapshot
    gana sobre la línea viva.
  - GREEN focal: 4 archivos / 98 tests; TypeScript, build y `git diff --check`
    verdes. No se usaron remoto, `db reset`, `db push` ni ARCA.
  - ESLint focal conserva 49 `no-explicit-any` preexistentes en rutas ya
    modificadas; el build conserva advertencias históricas de rutas-test,
    `inputValidator()` y módulos Node externalizados. Sin warnings nuevos de
    esta tarea.
- Task 4 review round 1 (`3cc8a2a`): `Spec: FAIL`, `Quality: FAIL`.
  - Crítico: la preview fiscal reconstruía sus ítems y omitía `descripcion`,
    mientras creación usaba el adaptador correcto.
  - Importantes: faltaban montajes de alta/edición/detalle de presupuesto y la
    tabla de venta usaba índice como key aunque admite productos repetidos.
- Task 4 fix round 1/5 — implementación completa; revisión independiente pendiente.
  - RED observado en la ruta montada de venta: preview recibió P-1 sin
    `descripcion` y creación recibió `Base 10 L (Código 1234)`; tras reutilizar
    `itemsPayload`, ambos límites reciben el mismo payload.
  - Se agregaron tests montados para alta, edición/reprecio y detalle de
    presupuesto. Alta manda la descripción; edición parte del snapshot y no la
    pisa al cambiar cantidad/reprecio; el detalle la muestra.
  - `lineaId` UUID estabiliza los renglones de venta duplicados. La regresión
    elimina la primera de dos P-1 y conserva la descripción de la segunda.
  - GREEN: 6 archivos / 102 tests, TypeScript, build y `git diff --check`.
    ESLint conserva las 49 violaciones `any` históricas y build los warnings
    históricos ya documentados; los nuevos tests usan prefijo `-` y no agregan
    warnings de rutas. No se usaron remoto, `db reset`, `db push` ni ARCA.
- Task 4 complete (`c16fa81..3441fc9`). Independent re-review: `Spec: PASS`,
  `Quality: PASS`; no Critical, Important or Minor findings. Preview/create use
  one payload, mounted budget flows preserve descriptions, and duplicate rows
  have stable UI-only identities excluded from commercial payloads.
