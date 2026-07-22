# Lote de mejoras: Facturación · Caja · Remitos · Dashboard

**Fecha:** 2026-07-21
**Origen:** feedback de Leo + Maitena (WhatsApp con capturas del 21/07/2026).
**Alcance:** 12 requerimientos sobre comprobantes, cierre de caja, remitos internos, permisos, productos y vistas de pagos.

Este documento es la fuente de verdad del lote. Cada item tiene: problema, causa raíz (con `file:line`), cambio propuesto, archivos afectados y criterios de aceptación. La numeración `R#` se usa en el plan de implementación y en los mensajes de commit.

---

## Contexto de arquitectura (resumido)

- **Stack:** TanStack Start (React 19) + Supabase (Postgres, RLS, RPC `SECURITY DEFINER`). PDFs con jsPDF/autotable, Excel con `xlsx`.
- **Ventas:** toda la lógica atómica vive en la RPC `crear_venta` (migración vigente `20260718121000_g4_validaciones_crear_venta.sql`). El front (`ventas.nueva.tsx`) solo arma el payload; el server resuelve precios contra el catálogo, descuenta stock atómico y registra pagos/cta-cte.
- **Comprobantes:** enum `tipo_comprobante` = `FACTURA_A, FACTURA_B, FACTURA_C, NOTA_CREDITO, NOTA_DEBITO, REMITO, REMITO_OBRA, FAC_INTERNA_CTA_CTE`. Los tres últimos son **internos** (no van a AFIP). La letra fiscal la elige el server por matriz emisor×cliente (`src/lib/fiscal/codigos.ts:54` `determinarLetra`).
- **Medios de pago:** `venta_pagos` (1:N por venta). Las NC guardan `monto` negativo (devolución). No hay columna `forma_pago` en `ventas`.
- **Caja:** se abre sola con la primera operación del día; el "esperado" por forma sale de la RPC `caja_esperado`; el cierre se declara en `arqueo.tsx` → RPC `cerrar_caja`. PDF de cierre en `arqueo.tsx:45 pdfCierre`.
- **Roles:** binario `admin` / `empleado` (`app_role`). El rol vive en `user_roles`; la sucursal en `profiles.sucursal_id`. No hay permisos granulares hoy.

---

## R1 — Condición fiscal del cliente (RI / Monotributo / CF / Exento)

**Decisión de Leo:** *"si ya está la lógica no agreguemos nada más."* — **No se escribe código nuevo.** Sin integración de padrón AFIP.

**Estado actual (ya cumple):**
- El cliente ya guarda su condición en `clientes.tipo` (`clientes.tsx:145-154`: CF / RI / Monotributista / Exento).
- La letra se decide server-side por matriz emisor×receptor: emisor Monotributo → C; RI+RI → A; RI+otro → B (`src/lib/fiscal/codigos.ts:54-61`). El emisor se configura en el panel AFIP (`facturacion.tsx`, `fiscal.functions.ts:107` acepta `RESPONSABLE_INSCRIPTO | MONOTRIBUTO`).
- `crear_venta` ya bloquea Factura A a no-RI (`...g4_validaciones_crear_venta.sql:122-125`).

**Trabajo del lote:** queda como **criterio de aceptación** verificable en la fase de tests/Playwright, no como código:
1. Emitir Factura A, B, NC y ND end-to-end en modo simulado y confirmar que persisten y numeran bien.
2. Confirmar que la letra sale sola por condición del cliente.
3. Confirmar que si el emisor estuviera configurado como Monotributo, el tipo ofrecido/emitido es Factura C. (Factura C hoy no está en el dropdown de `ventas.nueva.tsx` — ver **R2** para exponerla condicionada al emisor.)

**Aceptación:** A/B/NC/ND se emiten y numeran correctamente; la letra corresponde a la condición del cliente; no se agrega ningún lookup externo.

---

## R2 — Dropdown de tipo de comprobante: exponer Factura C y renombrar "Fac. interna"

Dos cambios en el selector "Tipo comprobante" de `ventas.nueva.tsx:296-307`.

### R2.a — "Fac. interna Cta Cte" → "Factura interna" (y sale de cuenta corriente)

**Problema (img 1):** *"Fac interna no es de cta corriente"*. Hoy `FAC_INTERNA_CTA_CTE` está forzada a cuenta corriente y no impacta caja.

**Causa raíz:**
- Front: `ventas.nueva.tsx:50` — `TIPOS_CTA_CTE = new Set(["REMITO", "REMITO_OBRA", "FAC_INTERNA_CTA_CTE"])`.
- Server: `...g4_validaciones_crear_venta.sql:161` — `v_es_cta_cte := p_tipo_comprobante IN ('REMITO','REMITO_OBRA','FAC_INTERNA_CTA_CTE') OR ...`.

**Cambio:**
- **No se renombra el valor del enum** (`FAC_INTERNA_CTA_CTE` sigue siendo la clave en DB; renombrar un enum-value usado en funciones/índices es alto riesgo y no aporta valor). Solo cambia el **label** visible y el **comportamiento**.
- Sacar `FAC_INTERNA_CTA_CTE` del set de cuenta corriente en el **front** (`ventas.nueva.tsx:50`) y en la **RPC** (`crear_venta`, condición de `v_es_cta_cte`). Pasa a comportarse como comprobante **de contado** (muestra "Formas de pago", impacta caja), pero sigue siendo **no fiscal** (no va a AFIP; `TIPOS_INTERNOS` en `codigos.ts:32-36` no se toca — confirmado: `emitirComprobante` rechaza internos en `fiscal.functions.ts:310`, y `next_comprobante_numero` ya le da prefijo `FICC` en `20260713130000_...:33`).
- Actualizar labels: `format.ts:59` (`FAC_INTERNA_CTA_CTE: "Factura Interna"`), `ventas.nueva.tsx:305` (`<SelectItem>Factura interna</SelectItem>`).
- **Forzar contado (hallazgo de review Codex):** sacar el tipo del set automático **no impide** que el operador deje `condVenta = 'CTA_CTE'` manualmente. Como "Factura interna" nunca debe ser cuenta corriente:
  - **Front:** cuando `tipoComp === "FAC_INTERNA_CTA_CTE"`, forzar el selector de Condición a `CONTADO` y deshabilitarlo (como hoy se hace con `esCtaCte`, pero al revés). Ver `ventas.nueva.tsx:316-325`.
  - **Server:** en `crear_venta`, si `p_tipo_comprobante = 'FAC_INTERNA_CTA_CTE'` y `p_condicion_venta = 'CTA_CTE'`, rechazar (o forzar `CONTADO`). Decisión: **forzar CONTADO** en el server (más tolerante que rechazar).
- **Guarda de compatibilidad:** una Factura interna de contado necesita permitir pagos; hoy `v_es_cta_cte` gobernaba si se leían `p_pagos`. Al salir del set, ya entra por la rama de pagos normal. El cliente `condicion_cta_cte` deja de ser requisito para este tipo.

**Riesgo:** comprobantes `FAC_INTERNA_CTA_CTE` **ya emitidos** quedaron con `condicion_venta='CTA_CTE'` y movimiento en el libro de cuenta corriente. El cambio es **hacia adelante**: no se migran los históricos. Documentar en el commit. (Verificar en review si hay reportes que asuman que toda `FAC_INTERNA_CTA_CTE` es cta cte.)

### R2.b — Exponer Factura C condicionada al emisor

**Problema:** `FACTURA_C` existe en el enum, en la validación (`esFiscal` incluye C) y en la matriz de letra, pero **no está en el dropdown** (`ventas.nueva.tsx:299-305`).

**Aclaración (hallazgo de review Codex):** emitir Factura C **no es imposible** hoy aunque no esté en el dropdown — `emitirComprobante` determina la letra C por emisor monotributista y reescribe tipo/número al emitir (`fiscal.functions.ts:609`, `camposReescrituraLetra`). Exponer C es una mejora de **UX/claridad** (que el cajero de un emisor monotributo la vea y la elija explícitamente), no un desbloqueo de algo imposible.

**Cambio:** agregar `<SelectItem value="FACTURA_C">Factura C</SelectItem>`. Mostrarla **solo** cuando la condición del emisor sea Monotributo (leer la config del emisor ya disponible vía `fiscal.functions.ts`). **Recomendado:** condicionar al emisor para no confundir al cajero de un emisor RI. Requiere exponer `condicion_iva` del emisor al front (query liviana a la config fiscal). Si se prefiere el camino mínimo, mostrarla siempre y dejar que el server valide — pero el default es condicionarla.

**Aceptación:** con emisor RI, el dropdown muestra A/B/NC/ND + internos (sin C). Con emisor Monotributo, muestra C. "Factura interna" ya no pide cuenta corriente y sus pagos impactan caja.

---

## R3 — Bug del centavo: "Los pagos electrónicos superan el total" (1 centavo)

**Problema (img 2 y 3):** con Mercado Pago por el total exacto, el sistema rechaza con *"Los pagos electrónicos (153253.05) superan el total del comprobante (153253.04)."* Diferencia de **1 centavo**.

**Causa raíz — redondeo distinto front vs server:**
- **Server** redondea el IVA **por línea** (`...g4_validaciones_crear_venta.sql:192-193`): `v_iva_item := ROUND(v_sub_item * iva/100, 2)` y suma los redondeados → IVA total 26.597,63 → total 153.253,04.
- **Front** suma el IVA **sin redondear por línea** (`ventas.nueva.tsx:162-173`): acumula `base * iva/100` con full precision → IVA 26.597,6361 → total 153.253,05.
- El pago se **precarga con el total del front** (`addPago`, `ventas.nueva.tsx:207`: `Math.max(0, totales.saldo)`), que es 1 centavo mayor que el que calcula el server. La validación server (`:239`) es `v_pagos_no_efec > ABS(v_total)` (estricto) → rechaza por 0,01.

**Cambio (dos capas). El fix del front es el primario; el del server es defensa en profundidad, con una corrección importante que surgió en el review.**

1. **Front — REUTILIZAR el helper que ya existe (hallazgo de review Codex).** No crear un `money.ts` nuevo: ya existe `calcularTotales(items, percepciones)` y `round2` en `src/lib/fiscal/iva.ts:19,49`, que implementan **exactamente** el redondeo por-ítem del server (documentado como "el invariante que hace que AFIP acepte el comprobante": redondear a 2 decimales una vez por ítem y de ahí sumar exactos). Reemplazar el cálculo inline de `ventas.nueva.tsx:162-173` (`totales`) por una llamada a `calcularTotales(itemsFiscales, percepciones)` y aplicar el `signo` de la NC afuera. Idealmente la grilla por fila (`ventas.nueva.tsx:456-457`) usa el mismo `round2` para ser coherente. Con esto el front calcula el **mismo** total que el server (153.253,04) y el pago se precarga con ese valor exacto → nunca dispara la validación.

2. **Server — tolerancia de 1 centavo, PERO clampeando el monto persistido (corrección clave del review).**
   - En `crear_venta` relajar la comparación estricta `v_pagos_no_efec > ABS(v_total)` (`:239`) a `v_pagos_no_efec > ABS(v_total) + 0.01`. Igual para `v_pagos_suma > ABS(v_total)` (`:244`).
   - **Problema detectado por Codex:** si solo se relaja la comparación, un pago electrónico de `total + 0.01` **se inserta completo** en `venta_pagos` (`:370`) y `caja_esperado` lo cuenta como caja real → la caja queda esperando 1 centavo de más. El excedente **no** "se absorbe" hoy porque el mecanismo de vuelto (`:358-366`) solo descuenta de EFECTIVO.
   - **Fix:** extender la absorción de vuelto para que el excedente tolerado (`v_vuelto`) se descuente de **cualquier** forma de pago al insertar (no solo efectivo): recorrer los pagos y clampear la suma insertada a `ABS(v_total)`. Así `Σ venta_pagos.monto == v_total_pagado` y la caja cuadra exactamente. Esto ya es coherente con `v_total_pagado := LEAST(v_pagos_suma, ABS(v_total))` (`:247`), que ya clampea el total; solo falta que los inserts individuales respeten el mismo tope.

**Estrategia (confirmada en review):** el **server sigue siendo la fuente de verdad** del total; nunca se confía en un total mandado por el front (a lo sumo como dato diagnóstico). El front solo tiene que calcular con la MISMA fórmula (por eso se reutiliza `iva.ts`).

**Aceptación:** el caso exacto de la captura (2 ítems, MP por el total) guarda sin error. Tras guardarlo, `caja_esperado` de la sesión suma **exactamente** el total (sin 1 centavo de más). Un pago electrónico 1 centavo por encima ya no se rechaza y no descuadra la caja; uno claramente mayor (+$100) sí se rechaza. Test unitario que compare `calcularTotales` (front) contra el cálculo de la RPC para varios casos, y un test de RPC que verifique `Σ venta_pagos == total_pagado` cuando hay excedente tolerado.

---

## R4 — Nota de Crédito: traer los productos de la factura que rectifica

**Problema (img 4):** al elegir "Factura que rectifica", la grilla de productos queda vacía; hay que recargar todo a mano. Debería traer los ítems de esa factura, editables y borrables (para devolver solo parte).

**Estado actual:** `ventas.nueva.tsx` ya carga las facturas del cliente (`facturasDelCliente`, `:146-160`) y setea `cbteAsocId`, pero **no** trae los `venta_items` de la factura elegida.

**Cambio (solo front, sin tocar la RPC):**
- Al setear `cbteAsocId` (para NC **y** ND — ver R5), query a `venta_items` de esa venta: `select("producto_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,iva_porcentaje,descuento_porcentaje").eq("venta_id", cbteAsocId)`.
- Poblar `items` (estado existente, interfaz `ItemRow` en `:27-41`) con esas filas. Cada línea queda **editable** (cantidad, precio, descuento) y **borrable** (botón basura ya existe, `:479`).
- **Precio histórico (hallazgo de review Codex):** la RPC ignora el `precio_unitario_sin_iva` mandado salvo que difiera del catálogo actual ("pisado"), y re-lee el producto vigente (`crear_venta:186-187`). Si el precio del producto cambió desde la factura original, la NC saldría con el precio de **hoy**, no el facturado — incorrecto para una devolución. **Por eso los items precargados de una factura deben enviarse SIEMPRE con su `precio_unitario_sin_iva` histórico forzado** (tratados como "pisados"), no depender de la heurística de "pisado". En `ventas.nueva.tsx` marcar estos items con un flag `desde_factura` que fuerce el envío del precio en el `map` de submit (`:224-241`).
- **IVA histórico (limitación conocida):** `crear_venta` toma el `iva_porcentaje` del producto **actual** (`:193`), no el de la factura. Si la alícuota de un producto cambiara entre la factura y su NC, la NC saldría con el IVA nuevo. Se acepta como limitación (el IVA de un producto prácticamente no cambia); se documenta. Si se quisiera exactitud AFIP total, habría que respetar el `iva_porcentaje` del item para NC/ND en la RPC (fuera de alcance de este lote salvo que Leo lo pida).
- Traer también `stock_disponible` por sucursal para el warning (opcional; la NC reintegra stock, no lo consume, así que el warning de "excede stock" **no aplica** a NC — condicionar el badge para no mostrarlo cuando `esNotaCredito`).
- Manejar cambios de factura: si el usuario cambia `cbteAsocId`, **reemplazar** la grilla y avisar con toast. Si cambia el tipo de NC a factura normal, limpiar.

**Aceptación:** elegir una factura en una NC precarga sus productos con el precio **facturado** (no el de hoy); borrar una línea la quita del total; el total de la NC es negativo y refleja solo lo que queda. La NC se guarda y reintegra stock solo de las líneas que quedaron.

---

## R5 — Nota de Débito: traer productos + recargo (interés/mora)

**Problema (img 5):** Maitena usa la ND para **cobrar de más** (interés/mora o un precio mal cobrado) y hoy *"no me trae nada"* ni deja *"sumarle ni un porcentaje ni un monto"*.

**Decisión de Leo:** **Productos + recargo %/$**. La ND trae los productos de la factura (editables/borrables) **y** un campo de recargo (% y/o monto fijo). El recargo se guarda como **línea de concepto libre** (sin producto).

**Implicación de datos:** hoy `venta_items.producto_id` es **NOT NULL** (`20260629211713_...:240`). Una línea de "Interés/recargo" no tiene producto. Se necesita:

**Cambio de schema (migración nueva):**
- `ALTER TABLE public.venta_items ALTER COLUMN producto_id DROP NOT NULL;` — permite líneas de concepto libre.
- **`codigo` sigue NOT NULL (hallazgo de review Codex).** `venta_items.codigo` es `TEXT NOT NULL` (`20260629211713_...:241`). La línea de recargo **no** puede llevar `codigo = NULL` (rompería). Usa `codigo = 'RECARGO'` (constante). No se migra `codigo`.
- La FK sigue siendo válida (una FK nullable no exige valor). El kardex de stock ya **no** corre para ND (`crear_venta:298 CONTINUE WHEN NOTA_DEBITO`), así que una línea sin producto no rompe stock.
- Regenerar `src/integrations/supabase/types.ts` (hoy `producto_id: string` no nullable) tras la migración.

**Restricción crítica — concepto libre SOLO en NOTA_DEBITO (confirmado por Codex y por análisis propio).**
El default original ("permitir concepto libre en cualquier tipo") es **peligroso**: si un item sin producto entrara en una Factura/Remito/NC, las ramas de stock de `crear_venta` (`:303-350`) harían `INSERT` en `stock_sucursal`/`stock_movimientos` con `producto_id = NULL`, y ambas tablas son **NOT NULL con FK** (`stock_sucursal.producto_id`, `stock_movimientos.producto_id`) → explota. Además `anular_venta` (`20260714240000_...:105`) itera **todos** los items de la venta a anular y reintegra stock por `producto_id`.
**Mitigación (verificada):** `anular_venta` (`20260714220000_...:33-35`) **solo permite anular FACTURA_A/B/C** ("las notas se corrigen con otra nota"), así que una ND nunca pasa por ese loop. Por lo tanto, si el concepto libre se restringe a **NOTA_DEBITO** (que además no mueve stock), ningún `producto_id NULL` llega jamás a un INSERT sobre `stock_sucursal`. **La RPC debe rechazar explícitamente un item sin `producto_id` cuando el tipo NO es `NOTA_DEBITO`.**

**Cambio en la RPC `crear_venta`:**
- En el loop de ítems, ramificar: si `it->>'producto_id'` es null/ausente:
  - **Guarda:** si `p_tipo_comprobante <> 'NOTA_DEBITO'` → `RAISE EXCEPTION 'Sólo la Nota de Débito admite líneas sin producto (recargo/interés)'`.
  - Línea de concepto libre: tomar `descripcion` (obligatoria), `precio_unitario_sin_iva` (obligatorio), `iva_porcentaje` (default 21 o el que venga), `cantidad` (default 1). No hace `SELECT productos`, no mueve stock. Se inserta en `venta_items` con `producto_id = NULL`, `codigo = 'RECARGO'`.
- Mantener la validación de que un comprobante fiscal tiene total ≠ 0 y al menos una unidad (`v_qty_total`). Una ND de solo recargo tiene `cantidad=1` en la línea de recargo, así que pasa.

**Cambio en `ventas.functions.ts` (zod):**
- `itemSchema` (`:18-26`): `producto_id` pasa a `.uuid().optional().nullable()`; agregar `descripcion: z.string().optional()`, `precio_unitario_sin_iva` ya existe, `iva_porcentaje: z.number().optional()`. Validación cruzada: si no hay `producto_id`, exigir `descripcion` y `precio_unitario_sin_iva`.

**Cambio en el front `ventas.nueva.tsx`:**
- Para ND: precargar productos de la factura (misma query que R4, con precio histórico forzado).
- Agregar UI de **Recargo** (visible solo si `esNotaDebito`): un `%` y un `$` fijo. Al guardar, materializar el recargo como una línea de ítem de concepto libre: `{ producto_id: null, descripcion: "Recargo/interés s/ <numero_factura>", precio_unitario_sin_iva: montoRecargo, cantidad: 1, iva_porcentaje: 21, descuento_porcentaje: 0 }`.
- **Base del recargo % (decisión — señalar a Leo):** el `%` se calcula sobre el **subtotal sin IVA de las líneas de producto** de la ND (neto). El monto resultante del `%` se **suma** al `$` fijo si ambos se cargan. El IVA del recargo es **21%** (interés/mora se factura con IVA general). Si Maitena esperara otra base (p.ej. sobre el total con IVA) o el recargo exento de IVA, se ajusta — es una decisión de negocio menor, se confirma en la revisión del spec.
- `ItemRow` admite `producto_id: string | null` y `codigo` opcional (`'RECARGO'`). La grilla renderiza la línea de recargo con código "RECARGO" y sin picker de stock.
- Totales: el recargo entra al subtotal/IVA como una línea más (el helper `calcularTotales` de R3 lo cubre porque es una línea con `iva_porcentaje`).

**Riesgo (alto — el más delicado del lote):** tocar `crear_venta` para admitir ítems sin producto afecta el corazón transaccional. Mitigación: la rama de concepto libre es **aditiva** (solo cuando `producto_id` es null) y **restringida a ND** por guarda explícita; no cambia el path existente de ítems con producto. Cobertura: tests de RPC para (a) ND con productos + recargo, (b) ND de solo recargo, (c) factura normal sigue igual, (d) item sin producto en una FACTURA → error claro, (e) item sin producto y sin descripción/precio → error claro, (f) anular una factura normal sigue reintegrando stock sin tocar líneas de recargo (no aplica porque las facturas no tienen recargo, pero se verifica que el path de anulación no cambió).

**Aceptación:** una ND trae los productos de su factura; se le puede sumar 10% de interés o $5.000 fijo; el total es positivo (ND suma) y se guarda; la factura normal no cambia su comportamiento; el stock no se mueve por la ND.

---

## R6 — Perfiles que pueden vender con productos sin stock

**Problema (img 6):** *"algunos perfiles solo pueden registrar ventas con productos sin stock y otros no"*. El error *"Stock insuficiente de BASE SIST... hay 0.00, se piden 1.00"* es la guarda de `crear_venta`.

**Causa raíz:** el flag es **global** (`settings.permitir_stock_negativo`, `20260713120000_...:93`), sin UI, todo-o-nada. La guarda está en `crear_venta:326-341` (rama sin negativo) y usa `v_permite_neg` leído de `settings` (`:142-144`).

**Decisión de diseño:** hacerlo **por perfil de usuario** (no global, no por producto). Flag booleano en `profiles`. Admins siempre pueden vender sin stock.

**Cambio de schema (migración nueva):**
- `ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS permite_venta_sin_stock boolean NOT NULL DEFAULT false;`
- Trigger `guard_profiles_columnas` (`20260714200000_...:37-62`) hoy bloquea que un no-admin cambie columnas sensibles. Agregar `permite_venta_sin_stock` a las columnas que **solo un admin** puede cambiar (para que un empleado no se autohabilite).
- Función helper `SECURITY DEFINER STABLE`: `puede_vender_sin_stock(uid uuid) RETURNS boolean` → `is_admin(uid) OR (SELECT permite_venta_sin_stock FROM profiles WHERE id = uid)`.

**Cambio en `crear_venta`:**
- Reemplazar el gate global: `v_permite_neg := v_permite_neg OR public.puede_vender_sin_stock(v_uid);` (mantener también el global por compatibilidad, o migrar del todo al por-perfil — **decisión: OR de ambos**, el global sigue siendo un override maestro).
- El resto de la rama negativa (`:320-341`) no cambia: si `v_permite_neg`, el stock puede quedar negativo con su movimiento de kardex.

**Cambio en la UI de Usuarios (`usuarios.tsx`) — la UI NO tiene edición (hallazgo de review Codex):**
Hoy `usuarios.tsx` solo permite **crear**, **activar/desactivar** (toggle inline, `:98`) y **resetear contraseña** (`:95`). No hay diálogo de edición. Por lo tanto el flag se maneja en **dos puntos**, consistente con el patrón actual:
- **Al crear:** checkbox "Puede vender sin stock" en el form de "Nuevo usuario" (`:106-135`), agregado al `form` (`:60`) y persistido por `crearUsuario` (`usuarios.functions.ts`, que ya escribe `profiles`).
- **Para usuarios existentes:** un **toggle inline** en la tabla (columna nueva o icono, análogo al botón Power de activar, `:98`), que llama una server fn nueva `setPermiteVentaSinStock({ user_id, valor })` — análoga a `toggleUsuarioActivo` (`usuarios.functions.ts`), con chequeo `is_admin`.
- Exponer el flag en `use-current-user.ts` (`ProfileWithRole`) para que el front pueda ajustar la UX (ver siguiente punto).

**Cambio en `ventas.nueva.tsx` (UX, no autoritativo):**
- Hoy el front no bloquea por stock (solo warning, `:458-465`). Mantener así. Opcional: si el usuario **no** tiene el permiso y hay ítems que exceden stock, mostrar el warning más fuerte / prevenir el submit con un mensaje claro, pero la barrera real sigue en la RPC. **Default:** dejar el warning actual y confiar en la RPC (menos código, misma seguridad).

**Aceptación:** un empleado sin el flag que intenta vender sin stock recibe el error (comportamiento actual); un usuario con el flag (o admin) puede completar la venta y el stock queda negativo con su movimiento de kardex; un empleado no puede auto-otorgarse el permiso.

---

## R7 — Remito interno: lo aprueba solo el destinatario (sucursal destino)

**Problema (img 7):** cualquier admin aprueba cualquier remito. Debería aprobarlo **solo la sucursal destino**.

**Causa raíz:** `aprobar_remito` (`20260718100000_...:42-44`) solo chequea `is_admin`. El front (`remitos.tsx:103`) gatea los botones ✓/✗ por `cu?.isAdmin`.

**Decisión de Leo:** **destino + override admin.**

**Cambio en la RPC `aprobar_remito`:**
- Autorización nueva: `IF NOT (public.is_admin(v_uid) OR public.current_sucursal_id() = v_remito.sucursal_destino_id) THEN RAISE EXCEPTION 'Sólo la sucursal destino (o un administrador) puede aprobar este remito'; END IF;`
- Requiere leer `sucursal_destino_id` del remito bloqueado (ya se hace `SELECT ... FOR UPDATE`, `:48-58` — agregar la columna al select si no está).

**Cambio en el rechazo — convertir en RPC transaccional (hallazgo de review Codex):**
Hoy `rechazarRemito` (`stock.functions.ts:20-33`) hace un `UPDATE` directo por PostgREST y **no chequea `error` ni filas afectadas** tras el update (`:28`). Se reemplaza por una **RPC nueva `rechazar_remito(p_remito_id, p_motivo)`** `SECURITY DEFINER`, con:
- la misma autorización que aprobar (destino o admin),
- guarda de estado (`FOR UPDATE`, solo PENDIENTE),
- set de `estado='RECHAZADO', motivo_rechazo, ...`.
Y `stock.functions.ts` la invoca (como `aprobarRemito`, `:6-18`). Esto elimina la dependencia de la policy `remitos update admin` para el rechazo y unifica el criterio de autorización con el approve.

**Cambio en el front `remitos.tsx`:**
- El select **ya trae** `sucursal_destino_id` vía `select("*", ...)` (`:39`) — **no hace falta** tocar el query (corrección al mapeo inicial).
- Gate de botones (`:103`): `(cu?.isAdmin || cu?.sucursal?.id === r.sucursal_destino_id) && r.estado === "PENDIENTE"`.

**Aceptación:** un empleado de la sucursal destino puede aprobar/rechazar; un empleado de otra sucursal **ve** el remito (la policy de SELECT de `remitos` es amplia) pero **no puede** aprobar/rechazar (no ve los botones y la RPC lo rechaza); un admin puede siempre (override). El origen no puede aprobar su propio remito (salvo que sea admin). El rechazo devuelve error claro si el remito no está pendiente o no está autorizado.

---

## R8 — Tamaño de envase en productos

**Problema (img 8 y 9):** falta el "tamaño del envase" (ENV: 1, 5, 20, 200) en productos. El Excel de importación ya trae la columna **ENV**.

**Causa raíz:** no existe ninguna columna de envase/tamaño en `productos`. La importación (`productos.importar.tsx`) no la parsea; la vista/form (`productos.index.tsx`) no la muestra.

**Cambio de schema (migración nueva):**
- `ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS tamano_envase numeric(10,2);` (nullable — no todos los productos tienen envase numérico). Sigue el patrón de `20260720100000_precios_descuento_proveedor.sql:23-24`.
- Unidad: es el número de la columna ENV (litros o kg según el producto). Se guarda el número; la unidad se infiere de `unidad_medida` existente. (No se agrega columna de unidad nueva para no ampliar scope.)

**Cambio en importación (`productos.importar.tsx`):**
- Agregar a `fieldsTarget` (`:21-34`) la entrada `{ key: "tamano_envase", label: "Envase (ENV)" }`.
- Agregar sinónimo en `sinonimos` (`:68-81`): `"env"`, `"envase"` → `tamano_envase`.
- Sumar al `payload` del upsert (`:266-277`): `tamano_envase: parseNum(row[...])`.

**Cambio en la vista/form (`productos.index.tsx`):**
- Form `ProductoDialog` (`:283-329`): campo `NumberInput` "Tamaño de envase".
- Payload insert/update (`:254-264`): incluir `tamano_envase`.
- Columna en la tabla (`:167-177` / `:186-205`): "Env." (opcional pero recomendado, el cliente lo pidió para verlo).
- Exports XLSX/PDF (`:82-120`): incluir la columna.

**Aceptación:** importar el Excel de precios llena el envase; el form permite editarlo; la tabla lo muestra; el export lo incluye.

---

## R9 — (reservado) — sin cambios

*(No hay R9 independiente; el feedback de envase quedó en R8 y las devoluciones en R10. Se mantiene la numeración para alinear con las capturas.)*

---

## R10 — Devoluciones (NC) en la pestaña Pagos: segregar como total aparte

**Problema (img 10):** una NC aparece como pago **negativo** dentro de un medio (ej. *"-$27.467,00 Devol."* en Transferencia) y netea los KPIs por medio. En el **dashboard** se ve bien porque ahí las NC se **excluyen** (`index.tsx:32-33 .neq("tipo_comprobante","NOTA_CREDITO")`); en **Pagos** no hay ese filtro (`pagos.tsx:65-71`).

**Decisión de Leo:** **segregar como total aparte.** Mostrar "Cobrado" (bruto positivo), "Devoluciones" como total separado, y "Neto cobrado = cobrado − devoluciones". Las devoluciones **no** aparecen como fila-pago fantasma dentro de un medio.

**Cambio (en `src/lib/pagos.ts` + `pagos.tsx`):**
- `normalizarCobros` sigue marcando `tipo: "DEVOLUCION"` por signo (`pagos.ts:62`). No se cambia el modelo.
- **El donut "Cobrado por medio" YA está bien (corrección del review Codex):** `pagos.tsx:125` ya llama `totalesPorMedio(cobros.filter(c => c.monto > 0))`, así que el donut ya excluye devoluciones. **No** es donde está el problema. El helper `totalesPorMedio` (`pagos.ts:86-95`) netea solo si se lo reutiliza crudo — mantenerlo así pero asegurarse de pasarle siempre positivos.
- **Dónde está el problema real:** (a) los KPIs "Efectivo"/"Electrónico" (`pagos.tsx:219-222`) usan `resumenPagos`, que netea (`pagos.ts:112-113`) — una NC de Transferencia baja el KPI "Electrónico"; y (b) la **tabla de movimientos** (`pagos.tsx:276-304`) muestra la NC como fila negativa dentro del medio.
- **KPIs:** mantener `totalNeto` (neto de devoluciones — sigue siendo el número real de caja) pero **agregar un KPI/línea explícita "Devoluciones"** = suma de `|monto|` de los cobros con `tipo === "DEVOLUCION"`, y mostrar "Cobrado bruto" y "Neto = bruto − devoluciones". Que la resta sea **visible y etiquetada**, no un negativo escondido en un medio. Los KPIs Efectivo/Electrónico pasan a mostrar el **bruto positivo** por medio (o se etiquetan claramente como netos — decisión: mostrar bruto y el total de devoluciones aparte).
- **Tabla de movimientos:** las devoluciones siguen listándose (trazabilidad legítima) con su badge "Devol.", pero se saca su efecto de las **filas/KPIs por medio**. La tabla ya las distingue con el badge (`pagos.tsx:300`).
- **Export XLSX (`pagos.tsx:135-149`):** que la columna de tipo (COBRO/DEVOLUCION) quede clara; el total del export debe cuadrar con "Neto".

**Aceptación:** en Pagos, ningún medio de pago muestra una devolución como negativo embebido; hay un total "Devoluciones" separado y un "Neto cobrado" que es cobrado − devoluciones; los números cierran con el dashboard.

---

## R11 — Cierre de caja: solo Efectivo editable; el resto automático (esperado del sistema)

**Problema (img 10, texto):** *"solo el efectivo deben poder ingresar, el resto debe venir el monto esperado automáticamente según lo registrado en el sistema."*

**Causa raíz:** en el modal de cierre (`arqueo.tsx CerrarDialog:303-383`), las **6 formas** son editables y **ninguna** viene precargada (`contado` arranca `{}`, `:305`). El cajero tipea los 6 a mano.

**Cambio (solo front, sin tocar la RPC `cerrar_caja`):**
- En `CerrarDialog`, para toda forma **distinta de EFECTIVO**: mostrar el input **read-only/disabled** con `value = neto(esperado[f])` (el esperado del sistema). Solo **EFECTIVO** queda editable (es lo único que se cuenta físicamente y puede tener diferencia).
- En el builder del payload (`:311-312`): para no-efectivo enviar directamente `neto(esperado[f])`; para efectivo, lo tipeado (`contado.EFECTIVO`). Resultado: la "Diferencia" de todo lo electrónico es 0 por construcción, y solo Efectivo puede mostrar faltante/sobrante.
- `NumberInput` ya soporta `disabled`/`readOnly` vía `...rest` y sincroniza su texto desde `value` externo cuando no está enfocado (`number-input.tsx:24-31`), así que precargar el `value` lo muestra correctamente.
- Ajuste visual: dejar claro (texto de ayuda) que "solo se cuenta el efectivo; el resto es lo registrado por el sistema".

**Aceptación:** el modal de cierre solo deja editar Efectivo; las demás formas muestran el esperado y no son editables; la diferencia electrónica es siempre 0; el efectivo puede cuadrar o mostrar diferencia; el cierre persiste igual que hoy.

---

## R12 — PDF de cierre de caja: agregar detalle de ventas del día + forma de pago

**Problema (img 11 y 12):** el PDF de cierre solo trae la tabla Esperado/Contado/Diferencia. Debería incluir, como el Excel de ventas, el **detalle de todas las ventas del día** (comprobante, tipo, cliente, total) **y cómo pagó** (forma de pago). Además, agregar forma de pago al **Excel de ventas**.

### R12.a — Segunda tabla en el PDF de cierre

**Causa raíz:** `pdfCierre(s, sucNombre)` (`arqueo.tsx:45-75`) recibe solo la sesión; no tiene datos de ventas. Las ventas se atan a la sesión por `ventas.caja_sesion_id` (`20260714210000_...:81-85`).

**Cambio:**
- Antes de generar el PDF (o dentro, haciéndolo async), query de las ventas de esa sesión con sus pagos: `select("numero_comprobante,tipo_comprobante,total,cliente:clientes(razon_social),pagos:venta_pagos(forma_pago,monto)").eq("caja_sesion_id", s.id)`.
- Tras la primera tabla (`lastAutoTable.finalY`, ya usado `:70`), agregar un segundo `autoTable`: columnas **Comprobante · Tipo · Cliente · Total · Forma(s) de pago**. La forma de pago se arma concatenando `venta_pagos` (`v.pagos.map(p => formaPagoLabel[p.forma_pago]).join(", ")`); para cta cte mostrar "Cta Cte".
- Como `pdfCierre` se llama desde el historial (`:421`), pasar las ventas ya fetcheadas o convertir el handler en async con un pequeño estado de loading. **Default:** hacer `pdfCierre` async y consultar Supabase adentro (más simple, es un click puntual).
- El header "CASAFORMA" hoy está hardcodeado (`:48`); reemplazar por `sucNombre`/nombre de empresa si está disponible (menor; no bloqueante).

### R12.b — Forma de pago en el Excel de ventas

**Causa raíz:** el export (`ventas.index.tsx:84-92`) no incluye forma de pago, y la query (`:46-57`) no embebe `venta_pagos`.

**Cambio:**
- Extender la query de `ventas` con `pagos:venta_pagos(forma_pago,monto)`.
- En `exportar` agregar columna "Forma de pago" = `v.pagos?.map(p => formaPagoLabel[p.forma_pago]).join(", ") || (esCtaCte ? "Cta Cte" : "—")`.

**Aceptación:** el PDF de cierre incluye una segunda tabla con todas las ventas de la sesión y su forma de pago; el Excel de ventas incluye la columna de forma de pago; ambos cuadran con los medios de la caja.

---

## Resumen de cambios por archivo

**Migraciones nuevas (Supabase) — `crear_venta` en UNA sola migración final (review Codex):**
Todos los cambios sobre `crear_venta` (R2.a forzar contado, R3 tolerancia+clamp, R5 concepto libre restringido a ND, R6 `puede_vender_sin_stock`) van en **una única** migración `CREATE OR REPLACE` basada en la **versión vigente de 12 argumentos** (`20260718121000`), para no dejar sobrecargas vivas ni pisar cambios previos.
- `venta_items.producto_id` → nullable (R5); `codigo` sigue NOT NULL, la línea de recargo usa `'RECARGO'`.
- `crear_venta` (migración unificada): R2.a, R3, R5, R6.
- `profiles.permite_venta_sin_stock` + helper `puede_vender_sin_stock` + guard trigger (R6).
- `aprobar_remito`: autorización por sucursal destino + override admin (R7).
- `rechazar_remito` (RPC nueva, transaccional) (R7).
- `productos.tamano_envase` (R8).
- Regenerar `src/integrations/supabase/types.ts` tras las migraciones.

**Frontend:**
- `ventas.nueva.tsx`: R2 (dropdown + forzar contado en interna), R3 (usar `calcularTotales` de `iva.ts`), R4 (NC trae items con precio histórico), R5 (ND items + recargo).
- `src/lib/fiscal/iva.ts`: **reutilizar** `calcularTotales`/`round2` existentes (R3) — no crear helper nuevo. Agregar test que compare contra el cálculo de la RPC.
- `ventas.functions.ts`: zod `itemSchema` admite concepto libre (R5).
- `format.ts`: label "Factura interna" (R2.a).
- `arqueo.tsx`: R11 (solo efectivo editable), R12.a (PDF detalle ventas).
- `ventas.index.tsx`: R12.b (forma de pago en Excel).
- `pagos.tsx` + `src/lib/pagos.ts`: R10 (segregar devoluciones — foco en KPIs y tabla, el donut ya está bien).
- `productos.importar.tsx` + `productos.index.tsx`: R8 (envase).
- `usuarios.tsx` (checkbox al crear + toggle inline) + `usuarios.functions.ts` (server fn nueva) + `use-current-user.ts`: R6 (flag por perfil).
- `remitos.tsx` (solo gate de botones; el query ya trae la columna) + `stock.functions.ts` (usar RPC `rechazar_remito`): R7.

---

## Orden de implementación sugerido (por riesgo/dependencia)

1. **R3** (bug del centavo, reutilizar `iva.ts`) — desbloquea ventas, base para R4/R5.
2. **R2** (dropdown/label + forzar contado) — bajo riesgo. **Front + RPC juntos** (review Codex).
3. **R8** (envase) — aislado, migración simple.
4. **R11** (cierre solo efectivo) — front puro.
5. **R12** (PDF + Excel) — front puro.
6. **R10** (devoluciones en pagos) — front puro, lógica de agregación.
7. **R6** (venta sin stock por perfil) — migración + UI.
8. **R7** (remito por destino) — **policy/RPC + server + front juntos** (review Codex).
9. **R4** (NC trae items) — front, usa `calcularTotales` de R3.
10. **R5** (ND items + recargo) — **el más riesgoso**: schema + corazón de `crear_venta`. Comparte el preload de items con R4. Se deja para el final, con más tests.

**Coordinación de la migración de `crear_venta` (review Codex):** R2.a, R3, R5 y R6 tocan `crear_venta`. Aunque se implementan/testean en el orden de arriba, **cada migración que la toque parte de la versión vigente de 12 args** (`20260718121000`) y hace `CREATE OR REPLACE` completo (nunca un parche parcial). El repo ya usa este patrón incremental (hay ~8 versiones históricas). Para minimizar fragmentación en este lote, **preferentemente** consolidar R3+R2.a+R6 en una migración temprana y R5 en la migración final (que suma la rama de concepto libre), ambas partiendo de la versión previa. Lo importante: no dejar sobrecargas de distinta aridad vivas.

R1 no implica código: es criterio de aceptación en la fase de tests.

---

## Riesgos transversales

- **`crear_venta` es el corazón transaccional.** R2.a, R3, R5 y R6 la tocan. Cada cambio es aditivo o acotado; se cubren con tests de RPC y no se altera el path feliz existente de ítem-con-producto.
- **Migraciones a producción:** la base de prod está en la cuenta "poldo" (ver memoria `supabase-produccion-quimex`). Deploy de migraciones con cuidado y en orden.
- **Datos históricos de `FAC_INTERNA_CTA_CTE`** (R2.a): el cambio es hacia adelante; no se migran los ya emitidos.
- **`venta_items.producto_id` nullable** (R5): mitigado restringiendo el concepto libre a ND (que no se anula ni mueve stock). Igual regenerar `types.ts`.

---

## Registro del review de spec (Codex, 2026-07-21)

El spec se pasó a Codex (paso 2 del pipeline) **antes** de implementar. Hallazgos incorporados (todos verificados contra el código):

1. **R3 — insert del pago no se clampea.** Relajar solo la comparación deja 1 centavo persistido en `venta_pagos` que descuadra `caja_esperado`. → Se agrega clamp del monto insertado al total. **[incorporado]**
2. **R3 — reutilizar `calcularTotales`/`round2` de `iva.ts:19,49`** en vez de crear `money.ts`. Ya implementa el redondeo por-ítem validado contra AFIP. **[incorporado]**
3. **R5 — `venta_items.codigo` es NOT NULL**: la línea de recargo usa `codigo='RECARGO'`, no NULL. **[incorporado]**
4. **R5 — concepto libre restringido a NOTA_DEBITO** con guarda explícita en la RPC (coincide con análisis propio: `anular_venta` solo anula facturas, así que ND nunca lleva `producto_id NULL` a stock). **[incorporado]**
5. **R4/R5 — precio histórico:** la RPC re-lee el producto actual; los items precargados de una factura deben forzar el envío del precio facturado. IVA histórico queda como limitación documentada. **[incorporado]**
6. **R2.b — corrección de hecho:** emitir Factura C no es imposible hoy (el server reescribe la letra); exponerla es UX. **[incorporado]**
7. **R2.a — forzar contado:** sacar el tipo del set no impide `condVenta=CTA_CTE`; se fuerza CONTADO en front y server. **[incorporado]**
8. **R7 — el query ya trae `sucursal_destino_id`** (`select("*")`); no se toca el query. Y `rechazarRemito` pasa a RPC transaccional. **[incorporado]**
9. **R10 — el donut ya usa positivos** (`pagos.tsx:125`); el fix real es en KPIs Efectivo/Electrónico y la tabla. **[incorporado]**
10. **R6 — la UI de usuarios no tiene edición**: el flag se setea con checkbox al crear + toggle inline en la tabla. **[incorporado]**
11. **Migración única de `crear_venta`** sobre la versión vigente de 12 args, para no dejar sobrecargas ni pisar cambios. **[incorporado]**
12. **Regenerar `types.ts`** tras el `producto_id` nullable. **[incorporado]**

**Decisiones de negocio (respuestas de Leo, 2026-07-21):**
- **IVA histórico en NC/ND (R4/R5):** ✅ **RESUELTO** — se toma el IVA del producto **actual**. Limitación conocida aceptada.
- **Forma de la ND (R5):** ✅ **RESUELTO** — Leo eligió **"Solo un % / monto extra"**: la ND **NO trae productos**, es un cargo sobre la factura (interés/mora). Base del %: **sobre el total con IVA** de la factura elegida. Esto **simplifica** R5 respecto al diseño original (ya no precarga productos en la ND) y **reduce el riesgo**: la línea de concepto libre es una sola (el recargo).
  - **Modelo:** recargo = `round2(totalFacturaConIVA × % / 100) + montoFijo`. Es el **total con IVA** de la ND. Se materializa como **una** línea de concepto libre (`producto_id = NULL`, `codigo = 'RECARGO'`, `descripcion = "Recargo/interés s/ <factura>"`, `cantidad = 1`), restringida a `NOTA_DEBITO` en la RPC.
  - **IVA del recargo:** ⏳ pendiente de una última confirmación de Leo (con IVA 21% desglosado —estándar para interés sobre venta gravada— vs. sin IVA). Matemáticamente el total de la ND es el mismo se calcule el % "sobre total c/IVA" o "sobre neto"; la única diferencia es si el recargo discrimina IVA por dentro.

---

## Registro del review adversarial (agentes, 2026-07-21)

Tras implementar 9 de 10 items, se corrió un review adversarial (2 agentes: uno sobre las migraciones SQL, otro sobre el front). Hallazgos confirmados y corregidos en el commit `fix(review)`:

1. **R7 — CRÍTICO (seguridad).** `aprobar_remito`/`rechazar_remito` comparaban `current_sucursal_id() = sucursal_destino_id` con `=`. Un empleado con `sucursal_id NULL` producía `false OR NULL = NULL`, y `IF NOT NULL` no dispara la excepción → podía aprobar/rechazar **cualquier** remito. Regresión respecto a la versión previa (solo `is_admin`, que nunca es NULL). **Fix:** `IS NOT DISTINCT FROM` (NULL-safe) en ambas funciones.
2. **R11 — CRÍTICO (race).** `cerrar_caja` recalcula el esperado en vivo, pero la UI mandaba el contado de las formas no-efectivo desde un snapshot cacheado → si entraba plata entre el fetch y el cierre (dos terminales comparten sesión), el server grababa una diferencia fantasma que la UI mostraba como 0. **Fix:** la UI manda **solo** el efectivo; `cerrar_caja` completa el resto con su esperado interno (diferencia 0 por definición). Además el botón "Confirmar cierre" se deshabilita si no se cargó el efectivo.
3. **R4 — precio histórico "pegado".** Al cambiar de NC/ND a factura normal, los ítems precargados quedaban con el precio histórico forzado, sin aviso → factura con precio viejo. **Fix:** effect que limpia los ítems precargados al dejar de ser nota + forzado condicionado a `esNota`.

**Nota no-bug:** el agente observó que "Ticket promedio" salió de los KPIs de Pagos (R10) — es una decisión deliberada (se priorizó la card "Devoluciones"); `resumenPagos.ticketPromedio` se conserva por si se reintroduce.

Las verificaciones matemáticas de R3 (clamp de pagos, invariante Σ venta_pagos == total_pagado) y R2/R6 (diffs incrementales de `crear_venta` sin pérdida de lógica) pasaron sin hallazgos.
