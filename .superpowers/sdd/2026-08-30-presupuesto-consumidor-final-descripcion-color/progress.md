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
- Task 5 — implementación y matriz final completas; revisión independiente pendiente.
  - RED montado observado: 9/9 casos iniciales fallaron porque el diálogo no
    ofrecía modo de receptor ni preflight de sucursal/caja. El GREEN focal
    cubre anónimo/identificado, loading/sin caja/error, null V2 y receptor
    efectivo, freeze de cierre y controles, doble clic/retry con key y payload
    estables, errores seguros y resultado tardío tras unmount. Una regresión
    adicional reprodujo el callback perdido bajo `StrictMode`; el guard de
    montaje se rearma en cada setup y quedó GREEN.
  - El diálogo usa un solo preflight autenticado al abrir. Consumidor Final
    limpia el cliente local, fuerza contado, oculta picker/CTA_CTE y envía null;
    la ruta conserva directamente el objeto autoritativo retornado antes de sus
    refetch. Loading, error, mantenimiento o cardinalidad de caja distinta de
    uno bloquean las dos acciones. Durante la mutación quedan congelados cierre,
    radios, selects, picker, pagos y botones.
  - Primer RED E2E: las tres historias de lectura/foco pasaron y la conversión
    no abrió fiscal; el trace y un RED montado aislaron el cleanup de ensayo de
    `StrictMode`. Después, fiscal abrió con Consumidor Final pero el preview
    falló porque la fixture sólo preparaba O'Higgins. Se agregó snapshot y
    restauración exacta independientes para emisor/PV/credencial mock de General
    Paz, siempre local y con marcadores `T13_TEST_ONLY_NO_NETWORK`.
  - Segundo recorrido: conversión, factura mock y PDF pasaron; la aserción PDF
    se hizo exacta sobre el literal escapado. La regresión CTA_CTE reveló por
    trace que su cliente de fixture no estaba habilitado; corregido el dato, el
    rerun aislado quedó 1/1. El último full previo quedó 5/6 únicamente por ese
    dato y se repetirá completo en la matriz final.
  - El E2E verifica presupuesto NULL/venta genérica efectiva, sucursal/caja,
    hash, descripción de color en DB/detalle/PDF, pago, stock, ausencia de deuda,
    doble clic y recarga sin duplicación; además no-caja sin mutaciones y cliente
    identificado con CTA_CTE. El cleanup borra sólo fixtures, restaura ambas
    configuraciones y el snapshot exacto de secuencias VENTA de las dos
    sucursales. Tras cada rerun se observaron cero cajas, credenciales mock y
    residuos.
  - El runbook incluye SQL ejecutable para candidato global, cajas por sucursal,
    flags/retiro legacy, auditoría de descripción/efectos y rollback fail-closed.
    Declara explícitamente: no autoapertura, no reactivar legacy y ningún
    certificado ARCA adicional para esta función comercial.
  - `vitest.config.ts` amplía el glob ya existente de `src/**/*.test.ts` a
    `src/**/*.test.{ts,tsx}`: utilidad mínima de harness necesaria para ejecutar
    el archivo `.test.tsx` exigido por el brief.
  - Matriz final desde `supabase db reset --local`: descripción personalizada,
    presupuesto Consumidor Final/caja/concurrencia, edición (19/19) y venta
    fiscal atómica GREEN; Vitest completo 85 archivos pasaron, 2 omitidos,
    1778 tests pasaron y 22 omitidos; TypeScript, build Vercel mock,
    E2E 6/6 y `git diff --check` GREEN.
  - ESLint focal no agrega deuda: los seis archivos nuevos/modificados fuera de
    la ruta pasan; `presupuestos.$id.tsx` conserva exactamente sus cuatro
    `no-explicit-any` históricos (mismas expresiones, líneas desplazadas). El
    build/E2E conserva warnings históricos de rutas-test, `inputValidator()` y
    el primer `getUser` previo al login, sin llamadas reales a ARCA.
  - Auditoría posterior al E2E: cero presupuestos/usuarios/cajas/credenciales
    mock de fixture, `comprobante_secuencias` VENTA vacío como tras el reset,
    flags restaurados a `false/false` y configuración de ambos emisores/PV
    idéntica al baseline.
- Task 5 review round 1 (`d98a771`): `Quality: FAIL` por un hallazgo Important.
  - El resultado ambiguo reactivaba controles: cliente/receptor/condición podían
    descartar el payload estable sin rotar la clave, y pagos podían mostrar un
    valor distinto del payload congelado.
- Task 5 fix round 1 — implementación completa; re-review independiente pendiente.
  - RED montado observado: 2/12 fallaron. Tras `Failed to fetch`, el radio quedó
    habilitado y un intento de editar cliente/pagos cambió la UI de uno a dos
    pagos antes del replay.
  - GREEN focal: 12/12. El estado ambiguo congela fieldset, receptor, picker,
    condición, pagos, Cancelar, X y Escape. Sólo la misma acción inicial queda
    disponible y conserva conjuntamente payload serializado, clave y decisión
    de facturar; los callbacks también rechazan cambios aunque un hijo los
    invoque programáticamente.
  - Verificación fresca: suite Vitest completa 85 archivos/1779 tests GREEN
    (2 archivos/22 tests omitidos), TypeScript y build Vercel mock GREEN. El
    build conserva únicamente sus warnings históricos ya inventariados.
- Task 5 scoped re-review round 2 (`bd8d5fa`): `Quality: FAIL` por dos hallazgos
  Important de máquina de estados.
  - Un error determinístico conservaba payload/key/acción estables; si seguía a
    un ambiguo, además dejaba todo congelado. El botón de replay ambiguo ignoraba
    `puedeConvertir`, pero su handler volvía a exigirlo.
- Task 5 fix round 2 — implementación completa; re-review independiente pendiente.
  - RED montado limpio: 4/16 fallaron. V2 y legacy reutilizaron la clave tras un
    error determinístico; un determinístico posterior a ambiguo no desbloqueó;
    y perder caja en el preflight impidió llamar el replay habilitado.
  - GREEN focal: 16/16. Sólo un último resultado ambiguo retiene payload, key y
    acción; repetirlo conserva bytes exactos y sigue congelado. Cualquier error
    determinístico, inicial o posterior a replay, limpia ambos refs, rota UUID y
    desbloquea controles/cierre dejando el error seguro visible. El siguiente
    intento refleja pagos/acción V2 o comprobante/forma legacy corregidos.
  - El handler de click usa el mismo predicado que los botones: un replay exacto
    no depende de un refetch de caja, mientras una acción distinta sigue
    bloqueada. Los callbacks legacy también rechazan cambios durante ambiguo.
  - Verificación fresca parcial: focal 16/16 y suite Vitest completa 85
    archivos/1783 tests GREEN (2 archivos/22 tests omitidos); TypeScript GREEN.
    Un primer typecheck detectó sólo una introspección `.mock` mal tipada en la
    prueba nueva; se reemplazó por el contrato completo de `onConvertida` y se
    repitieron focal, suite y typecheck en verde.
  - Build Vercel mock, Prettier/ESLint focal y `git diff --check` GREEN; el build
    conserva sólo warnings históricos de rutas-test, deprecaciones y módulos
    Node externalizados. No se usaron Supabase, red, deploy ni ARCA.
- Task 5 final scoped re-review (`bd8d5fa..2039b46`): `Spec: PASS`,
  `Quality: PASS`; no hay hallazgos Critical, Important ni Minor. El reviewer
  confirmó las transiciones determinística/ambigua, el replay exacto aunque
  cambie el preflight, la paridad V2/legacy y los resets de apertura/unmount.
  Evidencia fresca del review: focal 16/16, suite completa 1783 tests,
  TypeScript y `git diff --check` GREEN; árbol limpio. Task 5 lista para la
  revisión integral del release.
- Final review fix wave (`086def0..HEAD`) — implementación y matriz completas;
  commit final pendiente al momento de escribir este ledger.
  - Se verificaron técnicamente los cuatro hallazgos Important y los dos Minor.
    La compatibilidad no se resuelve relajando el contrato nuevo: cada renglón
    conserva su baseline autoritativo y omite `descripcion` sólo cuando los
    bytes siguen idénticos. Una edición real normaliza y valida 1..160 puntos de
    código Unicode. Esto cubre venta/preview, alta y edición de presupuesto y
    NC vinculada, incluso nombres históricos de más de 160 o que normalizan a
    vacío.
  - RED de primitivas: 3 archivos fallaron, con 4 tests fallidos y 10 verdes,
    por ausencia de baseline/provenance y clasificador de transporte. RED
    montado inicial: 2 archivos, 9 fallos y 36 pases. GREEN final de estas
    capas: los casos focales quedaron incluidos en 9 archivos/119 tests.
  - RED de rutas: 3 archivos fallaron, con 7 aserciones fallidas y 10 pases,
    además de la costura de import de edición. GREEN: 3 archivos/20 tests; las
    rutas ya no escriben presupuestos por RPC de browser y usan server functions
    autenticadas, esquemas estrictos y resultados cerrados.
  - RED de frontera cerrada: 2 archivos, 4 fallos y 29 pases. El diálogo agregó
    otro RED de 4/23 por resultados aún abiertos. GREEN: conversión, alta y
    edición sólo retornan código/mensaje del conjunto seguro; la causa cruda se
    registra exclusivamente en servidor y las pruebas inspeccionan
    recursivamente el resultado real. Un RED posterior de mapeo fue 2/11 y el
    caso mantenimiento fue 1/25; ambos quedaron GREEN sin ramas basadas en
    substrings SQL en el diálogo.
  - El clasificador ambiguo es acotado y tipado: reconoce Chrome, Safari,
    undici, AbortError, TimeoutError, causas/códigos anidados y proxy
    502/503/504 por campos exactos. Errores de negocio/DB determinísticos no
    clasifican como transporte y siguen descartando payload/key/acción; sólo
    una pérdida de respuesta congela y repite exactamente los tres.
  - RED SQL: convertir un snapshot de presupuesto de más de 160 bytes alcanzó
    `_normalizar_descripcion_item_20260830` y abortó. La migración
    `20260830220345` crea desde productos autoritativos y, en la misma
    transacción y antes de confirmar presupuesto/venta, copia exactamente las
    descripciones congeladas owner-side. Conserva locks, caja, idempotencia y
    timing fiscal; cualquier cardinalidad inesperada revierte todos los
    efectos. La NC V2 vinculada ignora el texto histórico del browser y llega a
    `anular_venta`, que copia verdad de DB.
  - Clarificación arquitectónica de release: no existe un orden app-first o
    DB-first seguro sin bridge, porque la app anterior lee snapshot/hash que
    revoca `20260830154723` y la nueva exige los contratos finales de
    conversión/cola. El runbook documenta el cutover real: preflight, staging
    `--prod --skip-domain`, mantenimiento y drain, todas las migraciones,
    promoción, smoke, flags y reapertura, con rollback forward-only/fail-closed.
  - El `maxLength` HTML se retiró porque cuenta unidades UTF-16. La ayuda y
    validación accesibles cuentan puntos de código; 160 astrales se aceptan,
    161 editados se rechazan y un snapshot largo sin cambios no queda atrapado.
    También se limpió el whitespace final de spec y plan.
  - Matriz fresca tras `supabase db reset --local`: descripciones, conversión/
    caja/concurrencia, edición 19/19, venta fiscal atómica y NC vinculada GREEN;
    focal 9 archivos/119 tests; Vitest completo 87 archivos/1834 tests GREEN,
    con 2 archivos/22 tests omitidos; TypeScript, build Vercel mock y E2E 6/6
    GREEN. El build sólo conserva warnings históricos ya inventariados.
  - Auditoría final local: cero presupuestos/productos/clientes/usuarios/
    perfiles/cajas/credenciales de fixture, secuencias VENTA 0/0, flags
    `false/false/false`, sin listener E2E en 8080. El stack local
    `gagrdirwlcunygtztiuk` se detuvo conservando su backup. No se usaron remoto,
    linked, deploy, push, ARCA, certificados ni flags externos.
