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
