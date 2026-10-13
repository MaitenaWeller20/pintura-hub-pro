# Tarea 9 — fachada estricta, flag y permiso asignable de NC por período

Fecha: 2026-08-29

Base exacta: `c70efbb795b8ff133e5663bf5a3cdff49781a55a`

Commit funcional: `1ff853781cad06a043b6cae82909388f2835c499` —
`feat(fiscal): exponer permiso y alta de NC por período`

## Resultado

Se expuso `crearNotaCreditoPeriodoFiscal` como acción POST autenticada. La
fachada vuelve a parsear el schema discriminado estricto de Tarea 3, relee los
tres flags sin cache, exige el cuadrante v2 exclusivo más el flag específico e
invoca únicamente `crear_nota_credito_periodo_fiscal`. Envía sucursal, cliente,
modalidad, período, motivo, resolución, líneas, reintegros e
`idempotency_key`; no admite ni transmite total, percepciones o fecha fiscal.

La respuesta PostgreSQL se acepta sólo como un arreglo de exactamente una fila
estricta `{venta_id, numero, es_cta_cte}` y se proyecta a
`{id, numero, cta_cte}`. Validaciones, fallos de settings y fallos de RPC/contrato
se convierten a errores fiscales tipados sin transportar SQL o detalles de red.
La RPC JWT-bound sigue siendo la autoridad final y revalida sesión, perfil,
sucursal, flag y capacidad dentro de su transacción; la acción no inicia una
segunda escritura comercial.

`FlagsFacturacion` y todas sus fixtures focales incorporan
`nota_credito_periodo_enabled`. `decidirEscritorFiscal` no usa el nuevo flag:
facturación v2/legacy ordinaria conserva exactamente su selección previa. La NC
vinculada previa continúa exigiendo `cbte_asoc_id` en v2 y una asociación nula
no cae en el writer interno legacy.

El usuario actual expone por separado `notaCreditoPeriodoHabilitada` y
`puedeEmitirNcPeriodo`. Un admin activo tiene capacidad efectiva por rol; un
empleado activo necesita simultáneamente `puede_facturar` y
`puede_emitir_nc_periodo`; perfiles inactivos, ausentes o sin rol empleado
fallan cerrado. Todos los selects explícitos relevantes y defaults incluyen la
nueva columna.

Se agregó `administrarPuedeEmitirNcPeriodo`: primero revalida al actor con
`is_admin` y recién después llama a la RPC segura
`administrar_puede_emitir_nc_periodo(p_profile_id, p_habilitado)`. El diálogo de
Usuarios muestra “Emitir NC por período”, deshabilitado para empleados hasta
habilitar la capacidad base, y explica el acceso efectivo de administradores.

## Archivos

- `src/lib/fiscal/feature.server.ts`
- `src/lib/fiscal/feature.server.test.ts`
- `src/lib/fiscal.functions.ts`
- `src/lib/fiscal.functions.test.ts`
- `src/lib/fiscal/cola.functions.ts`
- `src/lib/fiscal/cola.test.ts`
- `src/lib/ventas.functions.test.ts`
- `src/lib/usuarios.functions.ts`
- `src/lib/usuarios.functions.test.ts`
- `src/hooks/use-current-user.ts`
- `src/hooks/use-current-user.test.ts`
- `src/routes/_authenticated/usuarios.tsx`

`src/lib/ventas.functions.ts` no necesitó cambios productivos: las pruebas de
regresión demostraron que su cerco v2 ya rechaza la asociación nula antes de
todo writer, y extender `FlagsFacturacion` no alteró su ruteo.

No se tocó SQL, migraciones, tipos generados, UI de emisión, PDF ni ARCA.

## TDD RED / GREEN

### RED inicial

Primero se agregaron los contratos de tercer flag, acción ausente, payload/RPC,
normalización, gates, capacidad efectiva, mutación admin y fixtures. El comando
focal produjo el RED esperado:

```text
Test Files  4 failed | 2 passed (6)
Tests       25 failed | 95 passed | 8 skipped (128)
```

Las fallas observables fueron: `leerFlagsFacturacion` omitía el tercer booleano;
no existían la fachada/acción de alta; no existían la mutación/acción de
capacidad; y el acceso actual no proyectaba permiso ni flag.

Un ciclo posterior agregó primero el contrato de error al releer settings. RED:

```text
Test Files  1 failed | 1 passed (2)
Tests       1 failed | 39 passed (40)
expected null to be 'CONFIGURACION_INVALIDA'
```

También se comprobó la mutación de autorización para un perfil activo sin rol
empleado: antes del fix devolvía `true`; después falla cerrado. Durante ese RED
se corrigió además una expectativa de test mal ubicada, sin cambiar producción
para ocultarla.

### GREEN final

```text
Test Files  6 passed (6)
Tests       123 passed | 8 skipped (131)
```

El GREEN cubre el selector exacto de settings en dos invocaciones, rechazo de
filas ausentes/múltiples/malformadas, payload exacto sin importes calculados,
idempotencia, gates, respuesta estricta, errores tipados, ruteo ordinario,
capacidad efectiva y administración exclusiva.

## Verificaciones

- Focal obligatorio: 6 archivos pasados; 123 pruebas pasadas y 8 omitidas.
- `npm test`: 73 archivos pasados, 2 omitidos; 1560 pruebas pasadas y 22
  omitidas.
- `npm run typecheck`: OK.
- Prettier focal: todos los archivos coinciden con el formato.
- ESLint sobre los once archivos TypeScript focales sin deuda heredada: OK.
- `git diff --check` y `git diff --cached --check`: OK.
- No se ejecutó migration CLI, reset ni pruebas SQL porque la tarea no modificó
  SQL ni migraciones.

El lint de la lista completa de archivos del brief conserva 19 errores
`@typescript-eslint/no-explicit-any` preexistentes: uno en
`ventas.functions.ts` y dieciocho en `usuarios.tsx`. Ninguno corresponde a una
línea agregada por esta tarea. El warning de Vite sobre `vite-tsconfig-paths`
también es basal.

## Decisiones y riesgos

- El flag de período no se incorporó a `decidirEscritorFiscal`; sólo cerca la
  acción nueva, como exige el rollout independiente.
- La acción no consulta capacidad por separado: hacerlo abriría un TOCTOU. La
  única RPC de creación revalida capacidad, perfil y sucursal bajo la misma
  autoridad/operación; el middleware revalida la sesión y la lectura fresca
  cerca el rollout antes de mutar.
- Los tipos Supabase generados en esta base todavía no reflejan las migraciones
  ya presentes de Tareas 2/4. Se acotaron casts a los bordes de select/RPC, con
  contratos Zod/estructurales inmediatamente después. Regenerar tipos puede
  retirar esos casts en una tarea posterior sin cambiar el contrato.
- Los códigos humanos finales y el copy específico de outage siguen reservados
  para Tarea 11; aquí sólo se fijaron códigos transportables y fail-closed.
- `nota_credito_periodo_enabled` permanece apagado. No hubo deploy, push,
  producción, certificados ni llamadas a ARCA real.

## Fix round 1 — rol durable y errores seguros

Fecha: 2026-08-29

Base de la ronda: `a494eb5643d3626dc30f6e483d98ef412716041b`

Commit funcional: `1d38b5add56f6db8d1091ab6d912054989ea56d1` —
`fix(fiscal): exigir rol empleado para NC por período`

### Resultado

La capacidad autoritativa ya no se deriva de tres booleanos huérfanos. La
migración forward-only
`20260829223057_exigir_rol_empleado_nc_periodo.sql`, creada con
`supabase migration new`, recrea `puede_emitir_nc_periodo(uuid)` para que:

- un administrador activo conserve la semántica efectiva anterior;
- un empleado necesite el rol durable `user_roles.role='empleado'`, perfil
  activo, `puede_facturar=true` y `puede_emitir_nc_periodo=true`;
- un perfil sin rol o al que se le remueve el rol pierda capacidad de inmediato.

La RPC `administrar_puede_emitir_nc_periodo(uuid,boolean)` sigue autenticando al
admin activo dentro de PostgreSQL. Para habilitar toma lock del perfil y
`FOR KEY SHARE` del rol empleado; si el destinatario no tiene ese rol rechaza
con SQLSTATE estable `PNC01`. Deshabilitar sigue admitido para limpiar un flag
obsoleto después de retirar el rol. El perfil inexistente usa `PNC02`. Ambas
funciones preservan owner `postgres`, invoker/definer, `search_path=''`, firma,
ACL para `authenticated`/`service_role` y revocación a `PUBLIC`/`anon`.

Los fixtures SQL que representan empleados ahora insertan roles `empleado`
reales. Se agregaron casos explícitos de perfil sin rol, permiso almacenado sin
rol, remoción posterior y empleado autorizado. El enum durable sólo contiene
`admin` y `empleado`: el rol `admin` conserva su excepción contractual y la
ausencia de `empleado` falla cerrada; el rol desconocido continúa cubierto en
`use-current-user.test.ts`.

La acción administrativa dejó de reenviar `error.message`. Ahora emite
`ErrorAdministracionUsuario` con discriminante `codigo` y mensajes estables:
destinatario no empleado, perfil inexistente o fallo genérico. `message`,
`details`, `hint`, SQLSTATE inesperados, tablas y nombres de funciones no se
serializan al navegador. La causa original queda retenida sólo en el proceso
servidor mediante un `WeakMap`, sin ser propiedad del error transportable.

### Archivos de la ronda

- `supabase/migrations/20260829223057_exigir_rol_empleado_nc_periodo.sql`
- `scripts/test-nota-credito-periodo-schema.sh`
- `scripts/test-nota-credito-periodo-fiscal.sh`
- `src/lib/usuarios.functions.ts`
- `src/lib/usuarios.functions.test.ts`
- este informe

No se editaron migraciones históricas ni se cambió el writer ordinario, los
permisos de facturación, la UI, PDF, ARCA o el estado apagado del feature flag.

### TDD RED / GREEN

RED de acción antes del cambio productivo:

```text
Test Files  1 failed (1)
Tests       2 failed | 24 passed (26)
```

Los fallos mostraron literalmente `public.user_roles`, `profiles`, `schema`, el
nombre de la RPC y SQLSTATE `42P01`. También se agregó el contrato allowlisted
para `PNC02` antes del GREEN.

RED SQL sobre la base previa a la migración:

```text
ERROR: un perfil sin rol empleado obtuvo capacidad efectiva
ERROR: FALLO: los booleanos no habilitan a un perfil sin rol empleado
       (error recibido: la operación fue aceptada)
```

GREEN focal final:

```text
Test Files  6 passed (6)
Tests       126 passed | 8 skipped (134)
```

Los contratos SQL demostraron además que el admin activo sigue autorizado, un
empleado real con ambas capacidades funciona, la asignación a un perfil sin rol
se rechaza, el empleado no puede autoescalarse, retirar el rol revoca capacidad
y creación, y el admin puede limpiar el booleano stale.

### Verificaciones de la ronda

- Supabase CLI `2.116.0`; se consultó la ayuda vigente de `migration new` y
  `db lint` antes de ejecutar los comandos.
- `npx supabase db reset --local`: OK; aplicó desde cero todas las migraciones,
  incluida `20260829223057_exigir_rol_empleado_nc_periodo.sql`.
- `bash scripts/test-nota-credito-periodo-schema.sh`: OK; incluye owner,
  seguridad, `search_path`, ACL, admin, empleado, ausencia y remoción de rol.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: OK; incluye creación
  rechazada sin rol y después de removerlo, más idempotencia y carreras.
- Regresiones Tareas 4/8: `test-venta-fiscal-atomica.sh`,
  `test-fiscal-concurrencia.sh` (180 OK, 0 fallas),
  `test-conflictos-emision-rest.sh`, `test-anulacion-fiscal-vinculada.sh`,
  `test-anulacion-interna-idempotente.sh`, `test-liberar-claim-fiscal.sh`
  (9 OK, 0 fallas) y `test-snapshot-fiscal-v3.sh`: OK.
- `npm test`: 73 archivos pasados, 2 omitidos; 1563 pruebas pasadas y 22
  omitidas.
- `npm run typecheck`: OK.
- Prettier y ESLint focal sobre `usuarios.functions.ts` y su test: OK.
- `bash -n` sobre los dos scripts modificados: OK. `shellcheck` no está
  instalado en este entorno y no se ejecutó.
- `git diff --check` y `git diff --cached --check`: OK.

`supabase db lint --local --schema public --level warning --fail-on error`
mantiene un único diagnóstico basal: `42P01 relation "_objetivo" does not
exist` en `public.cambiar_precios_masivo`, definida en migraciones de julio. No
reportó un problema en las funciones de esta ronda y no se amplió el alcance
para corregir esa deuda ajena.

### Decisiones y riesgos de la ronda

- La autorización de creación sigue usando la misma RPC idempotente; al recrear
  el helper de capacidad, todos sus consumidores revalidan el rol en DB sin una
  consulta previa susceptible a TOCTOU.
- La asignación sólo exige rol al habilitar. Exigirlo también al deshabilitar
  impediría sanear permisos almacenados después de retirar un rol.
- Los códigos `PNC01`/`PNC02` son contrato servidor-servidor; la UI recibe sólo
  discriminantes propios y mensajes seguros. El copy final de outage permanece
  reservado para Tarea 11.
- El índice UNIQUE existente de `user_roles(user_id,role)` cubre la consulta y
  el lock exactos; no fue necesario agregar otro índice.
- El flag `nota_credito_periodo_enabled` continúa apagado. No hubo push, deploy,
  acceso a producción ni llamadas a ARCA real.
