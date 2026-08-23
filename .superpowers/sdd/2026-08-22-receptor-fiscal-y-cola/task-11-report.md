# Task 11 — informe de implementación

Fecha: 2026-08-23
Estado: **DONE**
Base exacta: `85e1c5c02263ee1aeefaebaabbd609c3c465d9a3`
Commit previsto: `feat(fiscal): exponer cola paginada y receptores`

## Resultado

La cola fiscal quedó expuesta mediante una única RPC paginada y user-bound:
`public.cola_fiscal_lectura(text,integer,integer,date,date,uuid,uuid,text,text,uuid)`.
Es `STABLE SECURITY INVOKER`, fija `search_path=''`, sólo puede ejecutarla
`authenticated` y repite dentro de PostgreSQL la autenticación, capacidad
`puede_facturar`, sucursal activa y asignación del empleado. El servidor usa el
cliente JWT de `requireSupabaseAuth`; no abre service role para cola ni
favoritos.

La RPC devuelve página, total filtrado, cuatro conteos y filtros seguros en una
sola sentencia/instantánea de base. Ordena por `fecha DESC,id DESC`, limita
`pageSize` a 100 y soporta fecha, sucursal, emisor, estado, documento comercial
o receptor congelado y venta exacta. `venta_id` omite el rango/selección de tab,
pero conserva RLS y scope de sucursal. La proyección enumera campos seguros y
no incluye snapshot, hash, claim token, errores crudos/SOAP, credenciales,
tickets, intentos ni evidencia administrativa.

Para Task 12, la misma respuesta incluye
`filtrosDisponibles:{sucursales:[{id,nombre}],emisores:[{id,razon_social,cuit}]}`.
El admin recibe opciones operativas permitidas y el empleado sólo su sucursal
efectiva; no se reutiliza `listarEmisores` ni se filtra configuración
administrativa. La futura acción `administrar_puede_facturar` debe seguir siendo
JWT-bound y no debe usar service role; Task 11 no implementa esa UI.

La clasificación conserva coexistencia legacy: `PENDIENTE/ERROR` aparecen como
incidentes de revisión y nunca reciben acción del escritor v2. El lease usa el
reloj de PostgreSQL y 300 segundos. Un `ERROR_CORREGIBLE` de más de cinco días
queda admin-only. En la auto-revisión se separó la FK viva usada para autorizar
de la ficha v2 congelada usada para mostrar: un snapshot incompleto no puede
saltar auth, pero tampoco oculta de la cola un incidente ya autorizado.

Los favoritos se listan activos y visibles en una sola consulta. Guardar es un
retry explícito sólo para una venta visible `APROBADO/PERSISTIDO`, con receptor
manual identificado validado por el normalizador compartido; sucursal,
`creado_por` y cliente se derivan del contexto/venta. Task 11 no escribe desde
preview. La baja usa la RPC idempotente existente y `DELETE` directo quedó
revocado para `authenticated`, sin policy DELETE.

## TDD: RED y GREEN

Se escribieron antes de producción los contratos de mapeo UI, consulta server,
contexto de permisos, favoritos, integración PostgreSQL y esquema.

RED observado:

```text
npm test -- src/lib/fiscal/cola-ui.test.ts src/lib/fiscal/cola.test.ts src/lib/fiscal/permiso.server.test.ts
cola-ui.test.ts: FAIL — no existía ./cola-ui
cola.test.ts: FAIL — no existía ./cola.functions
permiso.server.test.ts: FAIL — no existía autorizarContextoColaFiscal

bash scripts/test-receptor-fiscal-schema.sh
FAIL — no existía public.cola_fiscal_lectura
```

GREEN focal final:

```text
npm test -- src/lib/fiscal/cola.test.ts src/lib/fiscal/cola-ui.test.ts src/lib/fiscal/permiso.server.test.ts
Test Files  3 passed
Tests       37 passed | 4 skipped

DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
RUN_COLA_FISCAL_INTEGRATION=true npm test -- src/lib/fiscal/cola.test.ts
Test Files  1 passed
Tests       17 passed
```

La integración local carga más de 200 ventas y prueba página 3, orden total,
conteos/tabs coherentes, dos sucursales, employee/admin, documento comercial,
receptor congelado, venta antigua exacta, filtros seguros, estados legacy y
ausencia de secretos.

## Migración manual-only

Se creó exclusivamente con Supabase CLI:

```text
supabase/migrations/20260823030402_cola_fiscal_lectura.sql
```

Se ejecutó dos veces `supabase db reset --local` después de crear/ajustar la
migración; ambas terminaron con exit 0. Después de cada reset se regeneró
`src/integrations/supabase/types.ts` con Supabase local. No se aplicó ninguna
migración remota.

Orden manual acumulado que debe respetar el usuario:

1. `20260822133249_venta_fiscal_neutra_enum.sql`
2. `20260822133911_receptor_fiscal_outbox.sql`
3. `20260822144846_maquina_estados_emision_fiscal.sql`
4. `20260822161644_venta_fiscal_atomica.sql`
5. `20260822195131_proteger_evidencia_factura_a_emisores.sql`
6. `20260822203901_snapshot_fiscal_v2_completo.sql`
7. `20260822215956_snapshot_fiscal_v2_fechas_cuit_canonicos.sql`
8. `20260822232541_recuperar_cae_emision_fiscal.sql`
9. `20260822232546_lectura_exacta_emision_fiscal.sql`
10. `20260823030402_cola_fiscal_lectura.sql`

## Verificación final

| Comando | Resultado |
|---|---|
| `supabase db reset --local` | exit 0, repetido tras ajuste final |
| `bash scripts/test-receptor-fiscal-schema.sh` | contrato completo GREEN |
| integración local Task 11 | 17/17 |
| suite focal Task 11 | 37 aprobados, 4 omitidos opt-in |
| `bash scripts/test-fiscal-concurrencia.sh` | 174/174 |
| `bash scripts/test-venta-fiscal-atomica.sh` | contrato completo GREEN |
| `bash scripts/test-facturacion-multiemisor.sh` | contrato completo GREEN |
| `npm test` | 41 archivos aprobados, 1 omitido; 912 aprobados, 13 omitidos |
| `npm run typecheck` | exit 0 |
| ESLint acotado a archivos Task 11 | exit 0 |
| `INVOICING_MOCK_MODE=true npm run build:vercel` | exit 0 |
| `git diff --check` | exit 0 |

El build sólo mostró avisos preexistentes de `inputValidator`,
`vite-tsconfig-paths` y tamaño de chunks.

## Alcance y continuidad

- No se crearon columnas ni tablas.
- No se implementaron ruta, tabla, diálogo, polling ni administración de
  permisos de Task 12.
- No se ejecutaron Supabase remoto/MCP SQL/db push, ARCA real, red externa,
  deploy, push, flags, amend ni rebase.
- No se leyó ni modificó el checkout
  `/Users/leolorenzo/Desktop/Leo/quimex`.

## Archivos

- `supabase/migrations/20260823030402_cola_fiscal_lectura.sql`
- `src/lib/fiscal/cola.functions.ts`
- `src/lib/fiscal/cola.test.ts`
- `src/lib/fiscal/cola-ui.ts`
- `src/lib/fiscal/cola-ui.test.ts`
- `src/lib/fiscal/permiso.server.ts`
- `src/lib/fiscal/permiso.server.test.ts`
- `src/integrations/supabase/types.ts`
- `scripts/test-receptor-fiscal-schema.sh`
