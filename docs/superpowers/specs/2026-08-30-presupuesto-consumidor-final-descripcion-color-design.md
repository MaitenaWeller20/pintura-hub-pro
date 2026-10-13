# Diseño — presupuesto sin cliente y descripción personalizada por línea

**Fecha:** 2026-08-30
**Estado:** aprobado para implementación
**Base:** `1fea73d78506970afee431febe0391e0a9a3bef8`

## Objetivo

Permitir que un presupuesto sin cliente identificado se convierta en una venta de contado a Consumidor Final, conservando la sucursal del presupuesto y usando una caja que ya esté abierta en esa sucursal. Permitir además editar la descripción de cada producto para registrar códigos de color sin renombrar el catálogo, y congelar esa descripción en presupuesto, venta, comprobantes y PDF.

## Decisiones de dominio

### Consumidor final sin cliente

- `presupuestos.cliente_id` continúa nullable.
- `ventas.cliente_id` continúa `NOT NULL`.
- El navegador representa el modo anónimo con `cliente_id: null`; nunca conoce ni envía el UUID del cliente genérico.
- El servidor resuelve exactamente un cliente activo que cumpla:
  - `es_generico = true`;
  - `tipo = 'CONSUMIDOR_FINAL'`;
  - `sucursal_habitual_id IS NULL`;
  - `es_obra = false`.
- Los clientes `C.F. 101` y `C.F. 104` no son candidatos automáticos porque tienen sucursal habitual.
- Una migración agrega un índice único parcial para impedir más de un candidato activo. El despliegue debe ejecutar antes una consulta de preflight y detenerse con un mensaje humano si los datos reales ya son ambiguos.
- Si el modo es anónimo, la condición es obligatoriamente `CONTADO`. Cuenta corriente exige un cliente identificado y habilitado.
- Un UUID explícito que corresponda a un cliente `es_generico` se rechaza: el modo anónimo se expresa sólo con `null`.

### Sucursal y caja

- El presupuesto conserva su `sucursal_id`; no se mueve durante la conversión.
- La conversión usa esa sucursal tanto para la venta como para stock y caja, sin confiar en una sucursal enviada por el navegador.
- Debe existir una única sesión de caja `ABIERTA` creada antes de confirmar. La conversión no autoabre una caja.
- La RPC bloquea la sesión existente durante la transacción y comprueba que `ventas.caja_sesion_id` sea la misma sesión prevalidada.
- Si no hay caja abierta, la UI muestra la sucursal y el estado “No hay caja abierta”, deshabilita la confirmación y orienta a abrirla.
- El preflight de UI es informativo; la RPC revalida autorización, sucursal y caja atómicamente.

### Descripción personalizada

- Cada línea de venta directa y presupuesto admite una descripción personalizada de hasta 160 caracteres.
- La normalización elimina espacios extremos y colapsa secuencias internas de whitespace a un espacio.
- Si el campo está presente pero queda vacío o supera 160 caracteres, el servidor rechaza toda la operación sin mutaciones.
- Si el campo no está presente, los flujos nuevos conservan compatibilidad usando el nombre del catálogo.
- Al editar un presupuesto, omitir la descripción de una línea existente conserva su descripción histórica; una línea nueva sin descripción usa el catálogo.
- La descripción personalizada no cambia `productos.nombre`, código, precio, IVA, descuento, cantidad ni stock.
- `presupuesto_items.descripcion` congela el texto presupuestado y la conversión lo copia a `venta_items.descripcion`.
- Una venta directa guarda el texto en `venta_items.descripcion`; el snapshot fiscal, ticket y PDF lo consumen desde esa línea congelada.
- Una NC vinculada hereda la descripción histórica de la factura y no la vuelve editable.
- ARCA/WSFE recibe importes agregados, no el catálogo de renglones; cambiar el texto impreso no altera letra, IVA, CAE ni validez fiscal.

## API y persistencia

### Contrato de descripción

```ts
export const MAX_DESCRIPCION_ITEM = 160;

export function normalizarDescripcionItem(value: string): string;
```

Los payloads de `crear_venta`, `crear_presupuesto` y `editar_presupuesto` aceptan `descripcion?: string` en cada línea con producto. SQL aplica la misma regla de presencia, vacío y longitud.

### Conversión v2

```ts
type ConversionPresupuestoV2 = {
  entrada: "V2";
  presupuesto_id: string;
  cliente_id: string | null;
  condicion_venta: "CONTADO" | "CTA_CTE";
  pagos: PagoVenta[];
  idempotency_key: string;
};

type ConversionResultado = {
  id: string;
  numero: string;
  cta_cte: boolean;
  clienteId: string;
};
```

La RPC `convertir_presupuesto_en_venta_neutral` devuelve el `cliente_id` efectivo. Un hash persistido en el presupuesto cubre modo anónimo/identificado, cliente efectivo declarado, condición y pagos. Un replay exacto devuelve la misma venta; cambiar el payload con el presupuesto ya convertido devuelve conflicto.

El escritor legacy permanece retirado. No se recrea `convertir_presupuesto_en_venta` ni se amplía la matriz legacy.

### Preflight

Una server function autenticada devuelve una proyección cerrada:

```ts
type PreflightConversionPresupuesto = {
  presupuestoId: string;
  sucursalId: string;
  sucursalNombre: string;
  caja: null | { id: string; abiertaDesde: string };
};
```

La lectura usa la sesión del usuario y RLS antes de cualquier lectura privilegiada. No devuelve saldos, movimientos, cierres anteriores ni datos de otras sucursales.

## UX

- El diálogo de conversión muestra un radio accesible:
  - “Consumidor final / sin cliente”.
  - “Cliente identificado”.
- Un presupuesto sin cliente inicia en Consumidor Final; uno con cliente real inicia identificado.
- En modo anónimo se oculta el picker, se fuerza contado y se explica que cuenta corriente necesita identificar al cliente.
- Sucursal y caja aparecen siempre antes de confirmar.
- Cargando preflight, sin caja o con error: botones deshabilitados y mensaje con `role="alert"`/`aria-live`.
- La respuesta de la RPC, no el estado local, determina el `clienteId` que se usa al abrir la facturación.
- En las grillas de venta y presupuesto, la descripción es un `Input` etiquetado con ayuda: “Sólo cambia esta línea; no modifica el catálogo”.
- Las líneas heredadas de una factura para NC son readonly.

## Seguridad, concurrencia e idempotencia

- Todas las migraciones son forward-only y se crean con `supabase migration new`.
- Las RPC siguen `SECURITY DEFINER SET search_path=''`, validan `auth.uid()` y revocan `PUBLIC/anon`.
- La selección/autorización del presupuesto ocurre en una misma consulta y usa un mensaje opaco para inexistente o fuera de alcance.
- El resolver genérico cuenta candidatos; cero o ambigüedad falla cerrado.
- La caja se protege con advisory lock de sucursal y lock de fila; un cierre concurrente espera o provoca rollback, nunca autoapertura.
- El core interno de venta continúa owner-only.
- Idempotencia incluye la descripción congelada en el payload/hash de venta. Reusar una clave con otra descripción es conflicto.

## Pruebas de aceptación

- Presupuesto sin cliente se guarda y se muestra como tal.
- Conversión anónima de contado usa el genérico global, la sucursal y la caja abierta del presupuesto.
- Sin caja no hay venta, stock, pago ni cambio de estado del presupuesto.
- Cuenta corriente anónima y UUID genérico explícito fallan sin efectos.
- Replay exacto devuelve la misma venta; payload cambiado falla.
- Descripción `Base 10 L (Código 1234)` sobrevive alta, edición, PDF de presupuesto, conversión, venta, snapshot fiscal y PDF/ticket.
- Catálogo, IVA, precios y stock no cambian por editar la descripción.
- NC vinculada copia la descripción histórica y no permite editarla.
- RLS/BOLA, grants y limpieza de fixtures se prueban en Supabase local.

## Fuera de alcance

- Hacer nullable `ventas.cliente_id`.
- Crear o renombrar clientes/productos desde el diálogo.
- Abrir caja automáticamente durante una conversión.
- Reactivar el escritor fiscal legacy.
- Cambiar cómo ARCA determina letra, impuestos o CAE.
- Desplegar, habilitar flags o usar credenciales/certificados reales durante la implementación.

## Rollout

1. Ejecutar preflight de candidato global y cajas por sucursal en el entorno objetivo.
2. Aplicar migraciones en homologación/local equivalente y regenerar tipos.
3. Probar presupuesto anónimo, descripción, conversión y facturación/PDF por sucursal.
4. Confirmar que el escritor legacy sigue retirado y que el flujo fiscal permanece con su flag actual.
5. Recién después preparar producción; este trabajo no autoriza despliegue remoto por sí solo.
