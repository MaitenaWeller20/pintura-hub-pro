# Presupuesto sin cliente y descripción de color — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir presupuestos sin cliente en ventas de contado a Consumidor Final usando la sucursal/caja del presupuesto, y congelar una descripción personalizada por línea hasta ticket, snapshot fiscal y PDF.

**Architecture:** PostgreSQL conserva autoridad sobre cliente genérico, sucursal, caja, cálculos, stock e idempotencia. TypeScript aporta contratos cerrados y un preflight user-bound; React muestra el modo anónimo/identificado y edita sólo el snapshot descriptivo de la línea. Las migraciones redefinen únicamente los escritores vigentes y mantienen retirado el writer legacy.

**Tech Stack:** PostgreSQL/Supabase migrations y RLS, TanStack Start/Router/Query, React, Zod, Vitest, Playwright, pdf-lib, shell integration tests.

**Spec:** `docs/superpowers/specs/2026-08-30-presupuesto-consumidor-final-descripcion-color-design.md`

## Global Constraints

- `ventas.cliente_id` permanece `NOT NULL`; `presupuestos.cliente_id` permanece nullable.
- El navegador nunca recibe ni envía el UUID del Consumidor Final genérico automático.
- El candidato automático es el único cliente activo, global, no obra, `es_generico=true`, `tipo='CONSUMIDOR_FINAL'` y `sucursal_habitual_id IS NULL`.
- Sin cliente identificado sólo permite `CONTADO`; `CTA_CTE` exige cliente real.
- La conversión usa `presupuestos.sucursal_id`, exige caja ya abierta y nunca autoabre una caja.
- Descripción personalizada: máximo 160 caracteres tras normalizar; nunca truncar silenciosamente.
- La descripción no modifica catálogo, código, precio, IVA, descuento, cantidad ni stock.
- NC vinculada conserva su descripción histórica y continúa readonly.
- No recrear `convertir_presupuesto_en_venta` legacy ni editar migraciones ya aplicadas.
- Todas las pruebas de base usan Supabase local; no usar `--linked`, `db push`, MCP remoto ni ARCA real.
- No desplegar, pushear ni activar flags durante estas tareas.

---

### Task 1: Contrato y persistencia de descripción personalizada

**Files:**
- Create: `src/lib/item-descripcion.ts`
- Create: `src/lib/item-descripcion.test.ts`
- Modify: `supabase/migrations/20260830151434_descripcion_personalizada_items.sql`
- Create: `scripts/test-descripcion-personalizada-items.sh`
- Modify: `scripts/test-editar-presupuesto.sh`

**Interfaces:**
- Consumes: escritores vigentes `crear_presupuesto`, `editar_presupuesto` y `_crear_venta_core_20260823`.
- Produces: `MAX_DESCRIPCION_ITEM = 160`, `normalizarDescripcionItem(value)`, helper SQL owner-only `public._normalizar_descripcion_item_20260830(valor,fallback,presente)`, y los tres escritores capaces de congelar `descripcion`.

- [ ] **Step 1: escribir RED del normalizador TypeScript**

```ts
import { describe, expect, it } from "vitest";
import { MAX_DESCRIPCION_ITEM, normalizarDescripcionItem } from "./item-descripcion";

describe("descripción de una línea", () => {
  it("normaliza el código de color sin tocar su contenido", () => {
    expect(normalizarDescripcionItem("  Base 10 L   (Código 1234)  ")).toBe(
      "Base 10 L (Código 1234)",
    );
  });
  it("rechaza vacío y más de 160 caracteres", () => {
    expect(() => normalizarDescripcionItem(" \n\t ")).toThrow(/descripción/i);
    expect(() => normalizarDescripcionItem("x".repeat(MAX_DESCRIPCION_ITEM + 1))).toThrow(/160/);
  });
});
```

- [ ] **Step 2: comprobar RED**

Run: `npx vitest run src/lib/item-descripcion.test.ts`
Expected: FAIL porque el módulo todavía no existe.

- [ ] **Step 3: implementar el contrato puro**

```ts
export const MAX_DESCRIPCION_ITEM = 160;

export function normalizarDescripcionItem(value: string): string {
  const normalizada = value.trim().replace(/\s+/gu, " ");
  if (!normalizada) throw new Error("Ingresá una descripción para la línea.");
  if ([...normalizada].length > MAX_DESCRIPCION_ITEM) {
    throw new Error(`La descripción puede tener hasta ${MAX_DESCRIPCION_ITEM} caracteres.`);
  }
  return normalizada;
}
```

- [ ] **Step 4: escribir RED SQL transaccional**

En `scripts/test-descripcion-personalizada-items.sh`, usar el harness local de los scripts SQL existentes y envolver fixtures en `BEGIN/ROLLBACK`. Probar de forma independiente:

```sql
-- crear_presupuesto persiste el texto y no renombra el producto
SELECT * FROM public.crear_presupuesto(
  :'sucursal',
  jsonb_build_array(jsonb_build_object(
    'producto_id', :'producto', 'cantidad', 1,
    'descuento_porcentaje', 0,
    'descripcion', '  Base 10 L   (Código 1234)  '
  )), NULL, NULL, NULL, NULL
);
-- assert presupuesto_items.descripcion = 'Base 10 L (Código 1234)'
-- assert productos.nombre conserva el valor original.
```

Agregar casos que demuestren:

- campo ausente usa catálogo;
- campo presente vacío y 161 caracteres hacen rollback total;
- `editar_presupuesto` conserva descripción histórica si el payload la omite;
- `p_repreciar=true` cambia precio/IVA según contrato actual pero no descripción;
- venta directa copia descripción a `venta_items` sin cambiar catálogo/cálculos/stock;
- reusar una idempotency key con otra descripción devuelve conflicto y no duplica efectos.

- [ ] **Step 5: comprobar RED SQL**

Run: `bash scripts/test-descripcion-personalizada-items.sh`
Expected: FAIL porque los escritores actuales fuerzan `productos.nombre`.

- [ ] **Step 6: implementar helper SQL owner-only**

En `20260830151434_descripcion_personalizada_items.sql`:

```sql
CREATE OR REPLACE FUNCTION public._normalizar_descripcion_item_20260830(
  p_valor text,
  p_fallback text,
  p_presente boolean
) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path=''
AS $$
DECLARE v_texto text;
BEGIN
  IF NOT p_presente THEN RETURN p_fallback; END IF;
  v_texto := pg_catalog.regexp_replace(pg_catalog.btrim(p_valor), '[[:space:]]+', ' ', 'g');
  IF v_texto IS NULL OR v_texto = '' THEN
    RAISE EXCEPTION 'Ingresá una descripción para la línea';
  END IF;
  IF pg_catalog.char_length(v_texto) > 160 THEN
    RAISE EXCEPTION 'La descripción puede tener hasta 160 caracteres';
  END IF;
  RETURN v_texto;
END;
$$;
REVOKE ALL ON FUNCTION public._normalizar_descripcion_item_20260830(text,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
```

- [ ] **Step 7: redefinir sólo los escritores efectivos**

Copiar completos, desde su última definición vigente, `crear_presupuesto`, `editar_presupuesto` y `_crear_venta_core_20260823`; no copiar versiones históricas intermedias. En cada rama con producto usar exactamente:

```sql
v_descripcion := public._normalizar_descripcion_item_20260830(
  it->>'descripcion',
  v_fallback_descripcion,
  it ? 'descripcion'
);
```

Para alta, `v_fallback_descripcion := v_prod.nombre`. Para edición, construir `v_previo` con `descripcion`; si la línea existía, su fallback es la descripción previa, y si es nueva, `v_prod.nombre`. Guardar `v_descripcion` en el JSON calculado y luego en `presupuesto_items`/`venta_items`. Mantener sin cambios todas las expresiones de precio, IVA, signo, caja y stock.

- [ ] **Step 8: restaurar grants exactos y probar GREEN**

Run:

```bash
bash scripts/test-descripcion-personalizada-items.sh
bash scripts/test-editar-presupuesto.sh
bash scripts/test-venta-fiscal-atomica.sh
npx vitest run src/lib/item-descripcion.test.ts
```

Expected: todos PASS; `PUBLIC/anon` no ejecutan helpers internos.

- [ ] **Step 9: commit**

```bash
git add src/lib/item-descripcion.ts src/lib/item-descripcion.test.ts scripts/test-descripcion-personalizada-items.sh scripts/test-editar-presupuesto.sh supabase/migrations/20260830151434_descripcion_personalizada_items.sql
git commit -m "feat(ventas): congelar descripción personalizada"
```

---

### Task 2: Conversión anónima, sucursal, caja e idempotencia

**Files:**
- Modify: `supabase/migrations/20260830151440_conversion_presupuesto_consumidor_final_caja.sql`
- Create: `scripts/test-presupuesto-consumidor-final-caja.sh`
- Modify: `scripts/test-venta-fiscal-atomica.sh`

**Interfaces:**
- Consumes: descripción persistida por Task 1 y `convertir_presupuesto_en_venta_neutral` vigente.
- Produces: índice `uq_cliente_consumidor_final_global_activo`, columna `presupuestos.conversion_payload_hash`, RPC v2 que acepta `p_cliente_id NULL` y devuelve `cliente_id` efectivo.

- [ ] **Step 1: escribir preflight/RED SQL del candidato**

Agregar al script una consulta que cuente el candidato exacto y fixtures que prueben:

```sql
SELECT count(*)
FROM public.clientes c
WHERE c.activo
  AND c.es_generico
  AND c.tipo='CONSUMIDOR_FINAL'
  AND c.sucursal_habitual_id IS NULL
  AND NOT COALESCE(c.es_obra,false);
```

Casos RED: anónimo contado resuelve global; anónimo cuenta corriente falla; UUID genérico explícito falla; candidato ausente falla; segundo candidato viola unicidad.

- [ ] **Step 2: escribir RED de caja/sucursal/atomicidad**

Probar que:

- sin caja abierta no se crea venta y `caja_sesion_actual` no autoabre;
- una caja de otra sucursal no sirve;
- admin y empleado autorizado usan la caja de `presupuestos.sucursal_id`;
- cerrar caja concurrentemente no deja venta huérfana ni sesión distinta;
- `venta_items.descripcion` coincide con `presupuesto_items.descripcion`;
- presupuesto convertido mantiene `presupuestos.cliente_id IS NULL` en modo anónimo, pero la venta tiene el UUID global.

- [ ] **Step 3: escribir RED de replay y BOLA**

Probar replay exacto y conflictos al cambiar cliente/condición/pagos. Probar que presupuesto inexistente y fuera de alcance devuelven el mismo mensaje opaco y cero mutaciones. Verificar grants de la RPC y que el core/helper sigue owner-only.

- [ ] **Step 4: comprobar RED**

Run: `bash scripts/test-presupuesto-consumidor-final-caja.sh`
Expected: FAIL porque la RPC actual exige cliente, omite descripción y el trigger puede autoabrir caja.

- [ ] **Step 5: implementar esquema e invariante global**

En `20260830151440_conversion_presupuesto_consumidor_final_caja.sql`:

```sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.clientes c
      WHERE c.activo AND c.es_generico AND c.tipo='CONSUMIDOR_FINAL'
        AND c.sucursal_habitual_id IS NULL AND NOT COALESCE(c.es_obra,false)) > 1 THEN
    RAISE EXCEPTION 'Hay más de un Consumidor Final global activo; corregí los clientes antes de continuar';
  END IF;
END $$;

CREATE UNIQUE INDEX uq_cliente_consumidor_final_global_activo
ON public.clientes ((true))
WHERE activo AND es_generico AND tipo='CONSUMIDOR_FINAL'
  AND sucursal_habitual_id IS NULL AND NOT COALESCE(es_obra,false);

ALTER TABLE public.presupuestos
  ADD COLUMN conversion_payload_hash text,
  ADD CONSTRAINT presupuestos_conversion_payload_hash_sha256
    CHECK (conversion_payload_hash IS NULL OR conversion_payload_hash ~ '^[0-9a-f]{64}$');
```

- [ ] **Step 6: redefinir la RPC v2 completa**

Hacer `DROP FUNCTION public.convertir_presupuesto_en_venta_neutral(uuid,uuid,public.condicion_venta,jsonb,uuid)` antes de cambiar el `RETURNS TABLE`. Recrear con:

```sql
RETURNS TABLE(
  venta_id uuid,
  numero text,
  es_cta_cte boolean,
  cliente_id uuid
)
```

La implementación debe ejecutar en este orden:

1. autenticar y tomar advisory lock por presupuesto;
2. leer+autorizar presupuesto `FOR UPDATE` con mensaje “Presupuesto inexistente o sin acceso”;
3. construir hash canónico de `{modo, clienteId, condicionVenta, pagos}` sin incluir la key derivada;
4. si ya fue convertido, validar hash y devolver la venta existente antes de exigir caja/candidato activos;
5. si `p_cliente_id IS NULL`, exigir `CONTADO` y resolver exactamente un candidato global `FOR KEY SHARE`;
6. si no es null, exigir cliente activo y `NOT es_generico`;
7. tomar advisory lock de sucursal y una caja `ABIERTA FOR SHARE`; cero o más de una falla cerrado;
8. construir `v_items` incluyendo `'descripcion', i.descripcion`;
9. llamar `public.crear_venta(v_p.sucursal_id,v_cliente_efectivo,'VENTA',p_condicion_venta,v_items,p_pagos,0,v_p.observaciones,NULL,NULL,NULL,v_clave_venta)`;
10. verificar que la venta tenga la caja prevalidada;
11. actualizar presupuesto a `CONVERTIDO`, conservar su `cliente_id` original y guardar hash;
12. devolver `v_cliente_efectivo`.

- [ ] **Step 7: restaurar seguridad exacta**

```sql
REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta_neutral(
  uuid,uuid,public.condicion_venta,jsonb,uuid
) TO authenticated, service_role;
```

- [ ] **Step 8: probar GREEN y concurrencia**

Run:

```bash
bash scripts/test-presupuesto-consumidor-final-caja.sh
bash scripts/test-venta-fiscal-atomica.sh
```

Expected: todos los casos PASS, incluidos rollback, replay y cierre concurrente.

- [ ] **Step 9: commit**

```bash
git add scripts/test-presupuesto-consumidor-final-caja.sh scripts/test-venta-fiscal-atomica.sh supabase/migrations/20260830151440_conversion_presupuesto_consumidor_final_caja.sql
git commit -m "feat(presupuestos): convertir consumidor final con caja"
```

---

### Task 3: Contratos servidor, preflight y tipos Supabase

**Files:**
- Create: `src/lib/presupuestos.functions.ts`
- Create: `src/lib/presupuestos.functions.test.ts`
- Modify: `src/lib/ventas.functions.ts`
- Modify: `src/lib/ventas.functions.test.ts`
- Modify: `src/lib/fiscal.functions.ts`
- Modify: `src/integrations/supabase/types.ts`

**Interfaces:**
- Consumes: RPC/retorno de Task 2 y `normalizarDescripcionItem` de Task 1.
- Produces: `preflightConversionPresupuesto`, `PreflightConversionPresupuesto`, schema V2 nullable-obligatorio, `ConversionPresupuestoResultado.clienteId` y payloads con descripción normalizada.

- [ ] **Step 1: escribir RED de schemas y normalización**

Agregar pruebas:

```ts
expect(
  conversionPresupuestoInputSchema.parse({
    entrada: "V2",
    presupuesto_id: UUID.presupuesto,
    cliente_id: null,
    condicion_venta: "CONTADO",
    pagos: [],
    idempotency_key: UUID.key,
  }),
).toMatchObject({ cliente_id: null });

expect(() => conversionPresupuestoInputSchema.parse({
  entrada: "V2", presupuesto_id: UUID.presupuesto,
  condicion_venta: "CONTADO", pagos: [], idempotency_key: UUID.key,
})).toThrow();
```

Legacy debe seguir rechazando null. `ventaInputSchema` acepta `descripcion` sólo normalizada/no vacía/máximo 160 para líneas con producto.

- [ ] **Step 2: escribir RED del resultado autoritativo**

Probar que `normalizarConversion` rechaza una respuesta sin `cliente_id` y devuelve:

```ts
{ id: ventaId, numero: "GPZ-VTA-0001", cta_cte: false, clienteId: clienteEfectivo }
```

- [ ] **Step 3: escribir RED auth-first del preflight**

Probar orden `usuario-presupuesto → usuario-caja` y que una lectura denegada no abre admin. Probar DTO cerrado con sólo presupuesto/sucursal/caja y mensajes humanos para sin caja.

- [ ] **Step 4: implementar contratos**

Definir V2 con `cliente_id: z.string().uuid().nullable()` obligatorio y legacy con UUID. En el resultado leer `record.cliente_id`. Antes de RPC mapear `items` usando `normalizarDescripcionItem` cuando la propiedad esté presente. Extender el borrador fiscal para conservar `descripcion` sin usarla para cálculos.

- [ ] **Step 5: implementar preflight user-bound**

```ts
export type PreflightConversionPresupuesto = {
  presupuestoId: string;
  sucursalId: string;
  sucursalNombre: string;
  caja: null | { id: string; abiertaDesde: string };
};

export const preflightConversionPresupuesto = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value) => z.object({ presupuesto_id: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const { data: presupuesto, error: presupuestoError } = await context.supabase
      .from("presupuestos")
      .select("id,sucursal_id,sucursal:sucursales(nombre)")
      .eq("id", data.presupuesto_id)
      .maybeSingle();
    if (presupuestoError || !presupuesto) {
      throw new Error("No se pudo leer el presupuesto o no tenés acceso.");
    }
    const { data: cajas, error: cajaError } = await context.supabase
      .from("caja_sesiones")
      .select("id,abierta_en")
      .eq("sucursal_id", presupuesto.sucursal_id)
      .eq("estado", "ABIERTA")
      .limit(2);
    if (cajaError || (cajas?.length ?? 0) > 1) {
      throw new Error("No se pudo confirmar la caja de la sucursal.");
    }
    const sucursal = Array.isArray(presupuesto.sucursal)
      ? presupuesto.sucursal[0]
      : presupuesto.sucursal;
    if (!sucursal?.nombre) throw new Error("El presupuesto no tiene una sucursal válida.");
    return {
      presupuestoId: presupuesto.id,
      sucursalId: presupuesto.sucursal_id,
      sucursalNombre: sucursal.nombre,
      caja: cajas?.[0] ? { id: cajas[0].id, abiertaDesde: cajas[0].abierta_en } : null,
    };
  });
```

- [ ] **Step 6: reset local y regenerar tipos una vez**

Run:

```bash
supabase db reset --local
supabase gen types typescript --local
```

Guardar la salida en `src/integrations/supabase/types.ts`, normalizando sólo el EOF si `git diff --check` lo exige. Comparar nuevamente contra CLI local.

- [ ] **Step 7: probar GREEN**

```bash
npx vitest run src/lib/item-descripcion.test.ts src/lib/ventas.functions.test.ts src/lib/presupuestos.functions.test.ts
npm run typecheck
```

- [ ] **Step 8: commit**

```bash
git add src/lib/presupuestos.functions.ts src/lib/presupuestos.functions.test.ts src/lib/ventas.functions.ts src/lib/ventas.functions.test.ts src/lib/fiscal.functions.ts src/integrations/supabase/types.ts
git commit -m "feat(presupuestos): agregar preflight y modo anónimo"
```

---

### Task 4: Edición de descripción en ventas/presupuestos e impresión

**Files:**
- Modify: `src/routes/_authenticated/ventas.nueva.tsx`
- Modify: `src/routes/_authenticated/ventas.nueva.test.ts`
- Modify: `src/routes/_authenticated/presupuestos.nuevo.tsx`
- Modify: `src/routes/_authenticated/presupuestos.editar.$id.tsx`
- Modify: `src/routes/_authenticated/presupuestos.$id.tsx`
- Modify: `src/lib/presupuesto-pdf.test.ts`
- Modify: `src/lib/fiscal/comprobante-pdf.test.ts`
- Modify: `src/lib/fiscal/impresion.test.ts`

**Interfaces:**
- Consumes: `MAX_DESCRIPCION_ITEM`, schemas y escritores Tasks 1–3.
- Produces: inputs accesibles de descripción, payload estable y regresión completa de impresión/snapshot.

- [ ] **Step 1: escribir RED UI de venta directa**

Montar la ruta, agregar un producto, editar su descripción a `Base 10 L (Código 1234)` y afirmar que preview/creación reciben el mismo texto. Probar `maxLength=160`, ayuda accesible y que una línea `desde_factura` es readonly.

- [ ] **Step 2: implementar input de venta**

Reemplazar el texto estático de `it.descripcion` por:

```tsx
<Input
  aria-label={`Descripción de ${it.codigo}`}
  value={it.descripcion}
  maxLength={MAX_DESCRIPCION_ITEM}
  readOnly={it.desde_factura === true}
  onChange={(event) => updateItem(index, "descripcion", event.target.value)}
/>
```

Agregar ayuda visible “Sólo cambia esta línea; no modifica el catálogo”. Asegurar que el payload enviado a creación y preview se derive una sola vez y contenga `descripcion`.

- [ ] **Step 3: escribir RED UI de presupuesto alta/edición**

Probar que alta envía descripción, edición la carga desde `presupuesto_items.descripcion`, cambiar cantidad/repreciar no la pisa y el detalle la muestra.

- [ ] **Step 4: implementar grillas de presupuesto**

Renombrar el estado local ambiguo `nombre` a `descripcion`; inicializarlo desde catálogo al agregar y desde snapshot al editar. Enviar:

```ts
{
  producto_id: fila.producto_id,
  cantidad: Number(fila.cantidad),
  descuento_porcentaje: Number(fila.descuento || 0),
  descripcion: fila.descripcion,
}
```

- [ ] **Step 5: escribir regresiones PDF/ticket/snapshot**

En cada suite usar el texto exacto `Base 10 L (Código 1234)` y afirmar:

- PDF de presupuesto lo imprime;
- comprobante fiscal prefiere snapshot/venta congelada sobre catálogo vivo;
- ticket imprime la descripción;
- cambiar luego `productos.nombre` no cambia comprobantes históricos;
- NC vinculada imprime la descripción original.

- [ ] **Step 6: probar GREEN y accesibilidad**

```bash
npx vitest run src/routes/_authenticated/ventas.nueva.test.ts src/lib/presupuesto-pdf.test.ts src/lib/fiscal/comprobante-pdf.test.ts src/lib/fiscal/impresion.test.ts
npm run typecheck
```

- [ ] **Step 7: commit**

```bash
git add src/routes/_authenticated/ventas.nueva.tsx src/routes/_authenticated/ventas.nueva.test.ts src/routes/_authenticated/presupuestos.nuevo.tsx 'src/routes/_authenticated/presupuestos.editar.$id.tsx' 'src/routes/_authenticated/presupuestos.$id.tsx' src/lib/presupuesto-pdf.test.ts src/lib/fiscal/comprobante-pdf.test.ts src/lib/fiscal/impresion.test.ts
git commit -m "feat(ui): editar descripción de color por línea"
```

---

### Task 5: Diálogo de conversión, E2E y gate de entrega

**Files:**
- Modify: `src/components/presupuestos/dialogo-convertir-presupuesto.tsx`
- Create: `src/components/presupuestos/dialogo-convertir-presupuesto.test.tsx`
- Modify: `src/routes/_authenticated/presupuestos.$id.tsx`
- Modify: `e2e/presupuestos-facturacion.spec.ts`
- Modify: `e2e/fixtures/fiscal.ts`
- Create: `docs/presupuestos-consumidor-final-operacion.md`

**Interfaces:**
- Consumes: preflight y resultado efectivo Task 3, descripción Task 4, RPC Task 2.
- Produces: experiencia completa anónimo/identificado, caja visible, E2E DB/PDF y runbook de rollout.

- [ ] **Step 1: escribir RED montado del diálogo**

Casos obligatorios:

- presupuesto sin cliente inicia en “Consumidor final / sin cliente”;
- picker no aparece en anónimo y `CTA_CTE` no está disponible;
- sucursal siempre visible;
- loading/sin caja/error deshabilitan ambos botones;
- caja abierta muestra `abiertaDesde`;
- V2 envía `cliente_id: null` y callback usa `resultado.clienteId`;
- presupuesto identificado conserva picker;
- doble submit conserva key/payload y no duplica conversión;
- error de RPC queda humano con `role="alert"`.

- [ ] **Step 2: implementar selector y preflight**

Usar `RadioGroup` con valores `CONSUMIDOR_FINAL`/`IDENTIFICADO`. En anónimo ejecutar `setCondicion("CONTADO")`, limpiar cliente local y enviar null. Consultar `preflightConversionPresupuesto` al abrir y mostrar:

```tsx
<div aria-live="polite">
  <p>Sucursal: {preflight.sucursalNombre}</p>
  <p>
    {preflight.caja
      ? `Caja abierta desde ${fmtDateTime(preflight.caja.abiertaDesde)}`
      : "No hay caja abierta"}
  </p>
</div>
```

No permitir cerrar/cambiar controles durante la mutación. Usar el `clienteId` devuelto por servidor en `onConvertida`.

- [ ] **Step 3: escribir RED E2E real**

Extender fixtures locales con presupuesto sin cliente y producto de color. Historia completa:

1. abrir presupuesto de General Paz;
2. comprobar sucursal y caja General Paz;
3. elegir consumidor final y contado;
4. convertir;
5. verificar DB: presupuesto convertido con cliente null, venta con genérico global, misma sucursal/caja, descripción congelada, un pago, stock único;
6. abrir/facturar y descargar PDF;
7. verificar descripción y receptor Consumidor Final;
8. recargar y confirmar idempotencia.

Agregar historia sin caja: botones deshabilitados y DB sin mutaciones. Agregar presupuesto identificado/CTA_CTE como regresión.

- [ ] **Step 4: ejecutar E2E RED y luego GREEN**

Run: `npm run e2e -- e2e/presupuestos-facturacion.spec.ts`
Expected RED inicial por UI ausente; después de implementar, todas las historias PASS con cleanup.

- [ ] **Step 5: documentar operación**

El runbook debe incluir consultas concretas para candidato genérico, cajas abiertas por sucursal, descripción congelada y rollback. Debe decir expresamente que no se autoabre caja, que legacy sigue retirado y que ningún certificado ARCA adicional es necesario para esta función comercial.

- [ ] **Step 6: ejecutar matriz final en checkout limpio**

```bash
supabase db reset --local
bash scripts/test-descripcion-personalizada-items.sh
bash scripts/test-presupuesto-consumidor-final-caja.sh
bash scripts/test-editar-presupuesto.sh
bash scripts/test-venta-fiscal-atomica.sh
npm test
npm run typecheck
INVOICING_MOCK_MODE=true npm run build:vercel
npm run e2e -- e2e/presupuestos-facturacion.spec.ts
git diff --check
```

Después del commit y con árbol limpio:

```bash
npm run lint:no-new-debt
```

Expected: gates focales/completos GREEN; `npm run lint` global puede conservar deuda histórica, pero no puede aparecer deuda nueva.

- [ ] **Step 7: commit**

```bash
git add src/components/presupuestos/dialogo-convertir-presupuesto.tsx src/components/presupuestos/dialogo-convertir-presupuesto.test.tsx 'src/routes/_authenticated/presupuestos.$id.tsx' e2e/presupuestos-facturacion.spec.ts e2e/fixtures/fiscal.ts docs/presupuestos-consumidor-final-operacion.md
git commit -m "test(presupuestos): verificar consumidor final y colores"
```

---

## Self-review del plan

- Cobertura spec: cliente anónimo, candidato global, contado, sucursal/caja, idempotencia, descripción, impresión, NC histórica, seguridad y rollout tienen tarea/prueba explícita.
- No se modifica el writer legacy ni se hace nullable `ventas.cliente_id`.
- Las interfaces `cliente_id: null`, retorno `clienteId`, preflight y normalizador se producen antes de sus consumidores.
- Las migraciones tienen nombres reales generados por Supabase CLI.
- No quedan marcadores de implementación pendientes ni cambios remotos implícitos.

## Ejecución elegida

El usuario pidió ejecución con subagentes. Usar `superpowers:subagent-driven-development`: un implementador fresco por tarea, revisión independiente después de cada commit y revisión final del rango completo antes de preparar producción.
