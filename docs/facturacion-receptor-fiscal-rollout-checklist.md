# Task 14: checklist de rollout fiscal controlado

Estado de este documento: **preparación local solamente**. No autoriza un deploy, una migración
remota, un cambio de banderas, un backfill ni una llamada a ARCA. Las migraciones las ejecuta
manualmente el usuario autorizado y cada operación remota requiere aprobación separada.

## Roles y registro previo

- [ ] Autoridad explícita para aplicar migraciones: `__________`.
- [ ] Autoridad explícita para desplegar: `__________`.
- [ ] Operador de Supabase/SQL Editor: `__________`.
- [ ] Operador de Vercel: `__________`.
- [ ] Administrador fiscal y contacto contable: `__________`.
- [ ] Observador/segundo control: `__________`.
- [ ] Proyecto/ref y ambiente confirmados sin copiar credenciales al acta: `__________`.
- [ ] Hora UTC y hora Córdoba de inicio: `__________` / `__________`.
- [ ] HEAD exacto, rama y estado limpio registrados: `__________`.
- [ ] Backup/PITR verificado y restauración entendida: evidencia `__________`.
- [ ] Manifiesto y SHA-256 de este documento coinciden con los archivos; no hay migraciones remotas
      desconocidas.
- [ ] Se guardó evidencia local con `scripts/colectar-evidencia-fiscal-local.sh`.
- [ ] Unit, typecheck, lint, build mock, DB y E2E finales están verdes; IDs/logs: `__________`.
- [ ] No hay `.env`, `.crt`, `.key`, `.csr`, tickets, tokens ni SOAP/XML crudo en Git o evidencias.

## Manifiesto manual inmutable

SHA-256 calculado sobre el contenido exacto de cada archivo al cierre local. Comparar antes de
ejecutar; cualquier diferencia exige detenerse y revisar un nuevo manifiesto.

| Orden | Migración                                                        | SHA-256                                                            |
| ----: | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
|     1 | `20260822133249_venta_fiscal_neutra_enum.sql`                    | `296fa2152e4aa06650f0b8877ac4c9f0be624f43f6da3a138b60930e5e80bc39` |
|     2 | `20260822133911_receptor_fiscal_outbox.sql`                      | `4bb5a2152d531d011c5d5c22008c788b565a526f960a28437c0af1521211e985` |
|     3 | `20260822144846_maquina_estados_emision_fiscal.sql`              | `679d0bae210bb5f479cf8e36edcc75185b74893352a35c57be22f46f9ca33e93` |
|     4 | `20260822161644_venta_fiscal_atomica.sql`                        | `bc3584e955169a4e2b6f88dda9fffcf55dbedac2e6c61bf02c0a471802698e8e` |
|     5 | `20260822195131_proteger_evidencia_factura_a_emisores.sql`       | `ebcdcb63bae803142d8c57a28dc3716b05859882cd69dda51bcb7f78fd87924e` |
|     6 | `20260822203901_snapshot_fiscal_v2_completo.sql`                 | `ec66d5fef8703e633d4a03f142d36918d8995f2d3b8184ebe8f69b825ed4ba4c` |
|     7 | `20260822215956_snapshot_fiscal_v2_fechas_cuit_canonicos.sql`    | `5fc2293cc37b5ad04efc638282f28b9b27b6cdfdcedd2bc3bf18cceaf680eaa7` |
|     8 | `20260822232541_recuperar_cae_emision_fiscal.sql`                | `eaedbfe22727afe6bcc3a00e397245f113e0dc93d08c2356a284cc1aac9db6b7` |
|     9 | `20260822232546_lectura_exacta_emision_fiscal.sql`               | `de057070eebe91b6bf17e012872cee4dab2a6335a5986cde0edbf69c4bb3e15b` |
|    10 | `20260823030402_cola_fiscal_lectura.sql`                         | `9480cbbb544801845f1f5f13c24371c62dcd97f8f8d7a25526f7c585b90bbedb` |
|    11 | `20260823081724_conflictos_emision_no_reintentables.sql`         | `2d8c02a1343cee307c8ee3a9826fbe50a355dfc075de6b3dc43c726770fe67a3` |
|    12 | `20260823103551_bloquear_notas_debito_v2.sql`                    | `e4f87ec2599e3d9178155e03fad22807975fcb20392779266a9ad4e8cf78898f` |
|    13 | `20260823121146_cercar_notas_en_crear_venta.sql`                 | `40ddfc00279b5129c1e144ac498eb7863beeaa02858c8238c3e80975ab2cf0f4` |
|    14 | `20260823121846_liberar_claim_ante_reserva_fiscal_ajena.sql`     | `244b16ae91c849d557cdbdc577be5efdb58c7fb6a342554ac93259448b231288` |
|    15 | `20260823130734_recomputar_maximo_fiscal_bajo_lock.sql`          | `a3264543d82cf65aeee204cf2bb81fcab7d0c96283059c01222cc278ef3e52cb` |
|    16 | `20260823143000_crear_remito_atomico.sql`                        | `d2e2a49d92a885a684760290a1af0c395db9ca774f0530afa5890a9c3e1f2aaf` |
|    17 | `20260823160000_remitos_integridad_idempotencia.sql`             | `3554739cba7147b3a48b3e616d795a234416149afcbc605126f33c60607cd1cc` |
|    18 | `20260823162000_fix_venta_idempotencia_autorizacion.sql`         | `7a4e87044f1b869f051979bab0e1dd09643dd3c4a0dd0d310caa618f760b5cc9` |
|    19 | `20260823164000_restringir_liberacion_claim_fiscal.sql`          | `dd56b55bb4aae0a6852300d1d8d456efc74bc5a9839da38dae7288daa1b59af1` |
|    20 | `20260823165000_nota_credito_idempotente.sql`                    | `b14e354e266285ee3de8df8882fdb9270ba424ad69460dcf89fcb87a7af9839a` |
|    21 | `20260823170000_restringir_perfiles_inactivos_y_acl_remitos.sql` | `eb93fc0a7ce83f2be487aa597379a3b9d8bb8ab30d380f70c3abc5935722bef7` |
|    22 | `20260823172000_perfil_activo_autorizacion_global.sql`           | `87d7f7336b7d6a8718d2826341116745c88fad0d7a579b46504f96a3f70362dc` |
|    23 | `20260823173000_anulacion_neutral_idempotente.sql`               | `35e2c97613ad6c35ee7474a470804aa6f951eea0989cdecf3933ec5b74103d3b` |
|    24 | `20260823174401_barrera_postgrest_perfiles_activos.sql`          | `865df1c382abc61caf79b973ad5b45b7258994b1732e4d131a16039eaf2f8c0a` |
|    25 | `20260823180500_toggle_usuario_activo_cas.sql`                   | `aeaf6b67098ef8402049ae3adb63dbedd21ae0b6fa802df5bfcb24be2459e617` |
|    26 | `20260823182000_forzar_cierre_usuario_activo_fail_safe.sql`      | `49d2f52c03b36b60fa59a4ceb2620d8c8199a02c9d8152f2722d9a00d8f1919c` |

No forman parte del manifiesto `backfill_cola_fiscal` ni `retirar_escritor_fiscal_legacy`: sólo
pueden crearse después de sus respectivos gates post-deployment.

## Estado inicial obligatorio

- [ ] `facturacion_receptor_v2_enabled=false`.
- [ ] `facturacion_legacy_writer_enabled=true`.
- [ ] Conteos y digests de la cola registrados con la auditoría sólo lectura.
- [ ] Evidencia de Factura A estándar vigente por emisor, sin copiar su texto sensible al acta.
- [ ] PV, CUIT, ambiente y certificados corresponden a cada empresa.
- [ ] No existen todavía migraciones `backfill_cola_fiscal` ni
      `retirar_escritor_fiscal_legacy`; no se intentará crearlas o ejecutarlas en esta fase.

## Fase A — prefijo compatible, todavía sin v2

Aplicar manualmente, un archivo por vez y en el orden del manifiesto, desde
`20260822133249_venta_fiscal_neutra_enum.sql` hasta
`20260822144846_maquina_estados_emision_fiscal.sql`, inclusive.

- [ ] Antes de cada archivo se comparó su SHA-256.
- [ ] Cada archivo se ejecutó en su propia transacción desde SQL Editor (`BEGIN;` + contenido exacto + `COMMIT;`) y se verificaron sus postcondiciones de esquema antes de registrar la versión.
- [ ] Después de verificar cada archivo, desde el checkout vinculado se ejecutó el mecanismo oficial
      `supabase migration repair --status applied <VERSION> --linked`; nunca se hizo `INSERT`,
      `UPDATE` ni `DELETE` manual sobre `supabase_migrations`.
- [ ] `supabase migration list --linked` confirmó inmediatamente la versión local/remota exacta. Si
      repair o el listado no coincidieron, se abortó antes del archivo siguiente.
- [ ] Si se cortó la conexión, se inspeccionaron **por separado** esquema y ledger antes de decidir:
      si el esquema ya estaba aplicado, no se reejecutó el SQL; se verificó y recién después se hizo
      `migration repair`. Nunca se reintentó a ciegas.
- [ ] Se verificó después de cada archivo y se registró el query ID/operador/hora.
- [ ] Las banderas continuaron `v2=false`, `legacy=true`.
- [ ] No se ejecutó el modo aplicar de `backfill_cola_fiscal`.

Esta fase termina **antes** de `20260822161644_venta_fiscal_atomica.sql` (#4). Hasta #3 el frontend
anterior puede convivir. La #4 vuelve `next_comprobante_numero` owner-only y revoca su ejecución a
`authenticated`; el alta anterior de remitos, que reserva e inserta por pasos, falla desde ese
momento. No avanzar a #4 fuera de la ventana de mantenimiento.

## Fase B — ventana obligatoria por incompatibilidad de remitos

La incompatibilidad empieza en `20260822161644_venta_fiscal_atomica.sql` (#4), cuando el helper de
numeración pasa a ser owner-only. `20260823143000_crear_remito_atomico.sql` (#16) recién agrega una
RPC atómica de cuatro argumentos, pero no es un punto de convivencia: la #17 la reemplaza por la
firma idempotente de cinco argumentos, cierra las escrituras directas a
`remitos`/`remito_items` y restaura el helper exclusivamente a `service_role` por compatibilidad
temporal con el escritor fiscal legado. `authenticated` nunca recupera acceso directo al helper. El
cliente actual requiere el contrato final de la #17. No hay una secuencia segura sin mantenimiento
real.

- [ ] Se activó un mantenimiento que impide **todas** las nuevas escrituras comerciales, no sólo
      botones fiscales.
- [ ] Se registró la duración máxima real de requests/functions/transactions: `__________`.
- [ ] Se esperó al menos ese límite y la auditoría mostró que no quedan requests ni transacciones
      anteriores en curso.
- [ ] Se aplicaron #4 a #26, desde `20260822161644_venta_fiscal_atomica.sql` hasta
      `20260823182000_forzar_cierre_usuario_activo_fail_safe.sql`, uno por transacción, con hashes y
      postcondiciones verificados, y cada versión quedó registrada mediante `migration repair`.
- [ ] La auditoría sólo lectura distingue esquema de ledger y terminó sin la excepción
      `LEDGER_MIGRACIONES_INCOMPLETO`; `supabase migration list --linked` coincide con las 26 filas.
- [ ] La postcondición de #24 confirmó que el rol `authenticator` tiene
      `pgrst.db_pre_request=public.validar_perfil_activo_postgrest`, que la función existe con su
      contrato y ACL esperados, y que PostgREST recargó la configuración.
- [ ] La postcondición de #25/#26 confirmó las dos tablas CAS sin grants directos, las cuatro RPC
      `service_role`-only y el trigger que impide cambiar `profiles.activo` por fuera de una
      transición versionada.
- [ ] El contrato REST global confirmó que un JWT `authenticated` con perfil inactivo o ausente
      —o cuyo usuario está bloqueado/eliminado en Auth— recibe rechazo antes de leer, escribir o
      ejecutar RPC; un perfil activo y los contratos explícitos de `anon`/`service_role` siguen
      operando.
- [ ] El contrato CAS confirmó inicio/final idempotentes ante respuesta perdida, retry tardío
      supersedido, baja/alta concurrentes, reconciliación de la intención más nueva y cero perfiles
      publicados mientras GoTrue queda pendiente.
- [ ] El cierre fail-safe de #26 conservó el estado deseado vigente, quedó idempotente por clave y,
      al agotar carreras, dejó `profile=false/pending` sin informar éxito; un reintento posterior
      pudo recuperar y finalizar el estado.
- [ ] La auditoría `ESTADO_TOGGLE_CAS` dio cero en `pendientes_vencidas`,
      `pendientes_publicadas`, `divergencia_perfil` y `divergencia_auth`. Cualquier pendiente
      reciente se drenó o se dejó en mantenimiento con responsable explícito: `__________`.
- [ ] Se registró que esta barrera cubre exclusivamente la Data API/PostgREST: no intercepta Auth,
      Storage, Realtime ni otros productos, que requieren controles propios si entran en alcance.
- [ ] Se desplegó el cliente compatible sólo con autorización separada; ID: `__________`.
- [ ] El mantenimiento siguió activo mientras convivían instancias antiguas y nuevas.
- [ ] Se esperó y comprobó el drenaje de todas las instancias antiguas.
- [ ] El smoke sólo lectura de
      [Facturación fiscal: inventario de smoke](./facturacion-receptor-fiscal-smoke.md) quedó verde.
- [ ] Se confirmó que `authenticated` no puede escribir remitos directamente ni ejecutar el helper
      de numeración.
- [ ] Se confirmó que `service_role` conserva el helper sólo para el escritor fiscal legado. No se
      amplió ese permiso ni se lo usó manualmente.
- [ ] Se verificó salud, login, lectura de cola/configuración y ausencia de alertas RLS/lint nuevas.
- [ ] Antes de levantar el mantenimiento, una operación comercial controlada fue autorizada y su
      resultado revisado, o se dejó explícitamente pendiente: `__________`.
- [ ] Las banderas siguen `v2=false`, `legacy=true`; esta fase no habilita la v2.

## Gate posterior — backfill y corte fiscal (no incluido ni autorizado)

No marcar ni ejecutar esta sección como parte de Task 14 local. Requiere otra aprobación, un
despliegue compatible sano y una migración futura revisada.

- [ ] Se corrió `backfill_cola_fiscal(false)` y se comparó contra la clasificación SQL independiente.
- [ ] Se repitieron inmediatamente antes del corte los conteos y digests; no cambiaron y no hay filas
      inconsistentes o sin clasificar.
- [ ] Se puso el sistema otra vez en mantenimiento.
- [ ] Se establecieron **ambas** banderas en `false` de forma controlada.
- [ ] Se probaron rechazos de writers antes de cualquier efecto comercial y se drenó nuevamente.
- [ ] Se aplicó la futura migración atómica de backfill con sus aserciones; no se reconstruyó
      historia fiscal faltante.
- [ ] Se reconcilió el resultado y sólo después se retiró el escritor legado en otra migración.
- [ ] Se habilitó `v2=true`, `legacy=false` primero para administradores.
- [ ] Homologación fue tratada como una conexión real a ARCA homologación, no como simulación.
- [ ] La primera factura real tuvo confirmación humana de venta, receptor, letra, fecha, total,
      emisor, CUIT y PV.
- [ ] Se monitorearon `RECONCILIAR` y `BLOQUEADO` antes de habilitar empleados seleccionados.

## Abort y rollback seguro

Abortar ante hash/ledger desconocido, backup dudoso, tests fallidos, warning nuevo, banderas
incoherentes, instancia vieja sin drenar, datos cambiantes, evidencia A vencida, emisor/PV incorrecto,
tráfico externo inesperado, secreto en artefactos o una fila fiscal que no se pueda clasificar.

La posición inmediata de seguridad es:

```text
facturacion_receptor_v2_enabled=false
facturacion_legacy_writer_enabled=false
```

- [ ] Mantener el mantenimiento y preservar todos los registros y evidencias.
- [ ] No reactivar a ciegas el escritor legado.
- [ ] No borrar/reclasificar comprobantes legales, CAE, snapshots, intentos ni números.
- [ ] No reenviar una operación incierta; conciliar primero.
- [ ] Corregir esquema/datos hacia adelante. Un error legal se corrige con NC, no con rollback SQL.
- [ ] Registrar incidente, responsable y siguiente decisión: `__________`.
