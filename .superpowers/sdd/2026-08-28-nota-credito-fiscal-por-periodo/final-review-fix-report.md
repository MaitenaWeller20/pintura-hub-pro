# Final-review fix report

Status: implementation complete and locally verified; independent re-review is still pending.

## RED evidence

- Focused Vitest before implementation: 3 files failed, 16 tests failed, 59 passed and 8 skipped. The failures reproduced `nc_periodo_payload_hash` in the queue contract, recursive reserved-key acceptance, raw snapshot/hash in the operator projection and browser receiver derivation from the snapshot.
- Auth-first tests then failed for the missing list/original/exact-read facades, including the BOLA case where privileged reads must never open after user-bound denial.
- The first real ACL run after reset exposed an omitted explicit `SECURITY DEFINER` on the replaced queue function; the migration was corrected and reset from zero again before accepting the result.

## Implemented design

- `20260830154723_cerrar_acl_ventas_y_proyeccion_cola_fiscal.sql` replaces the effective queue projection, removes the period payload hash, exposes `reclamo_vencido` instead of a reserved `claim` key, preserves explicit auth/capability/branch checks and grants execution only to `authenticated`.
- The same forward-only migration revokes authenticated/PUBLIC/anon SELECT for the eight claim, snapshot and idempotency columns. `leer_venta_fiscal_exacta` remains service-role-only.
- Queue DTO validation rejects reserved keys recursively across rows and filter metadata.
- `/ventas` uses one user-bound safe list query followed by one batched exact server read and returns only a closed fiscal presentation. `/reportes` uses a minimal safe projection. Original selection returns `tiene_snapshot_persistido`, never snapshot/hash.
- Linked NC, PDF/detail and legacy reads authorize through the user session and RLS/section/capability boundary before importing service-role and selecting the minimum exact evidence. Raw evidence is not returned or embedded in errors.
- Operators with the Ventas section but without `puede_facturar` retain commercial list/detail access; original selection, preview and emission remain fiscal-capability-gated.

## Verification

- `supabase db reset`: PASS from zero after the final migration correction.
- `bash scripts/test-error-fiscal-no-expuesto.sh`: PASS; real authenticated SQLSTATE `42501` for all eight columns and recursive absence of `snapshot|hash|claim|idempotency|payload|raw|secret|service_role` from queue JSON.
- Queue ACL integration: 2 passed (v2/v3 output plus denied incapable/out-of-scope actors).
- `bash scripts/test-receptor-fiscal-schema.sh`: PASS.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: PASS, including post-CAE effects, recovery and concurrency assertions.
- `npm test`: 80 files passed, 2 skipped; 1,738 tests passed, 22 skipped.
- `npm run typecheck`: PASS.
- `npm run build`: PASS with only pre-existing route-discovery/deprecation and browser-externalization warnings.
- Focused Playwright (`facturacion-cola.spec.ts` + `nota-credito.spec.ts`): 18 passed. Bootstrap fetch, deprecated validator, route-test discovery and remito dialog-description warnings were pre-existing and did not produce a failure.

No remote Supabase, ARCA, certificates, deploy, push or linked operation was used.
