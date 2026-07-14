# Rediseño de UI — PinturaGest / CasaForma

**Fecha:** 2026-07-14
**Estado:** Aprobado el rumbo; revisado con Codex (ajustes incorporados); pendiente OK final del usuario.
**Alcance:** Rediseño visual de toda la app, dashboard como resumen + accesos, reportes con datos útiles, y una sección nueva de Pagos estilo MesaYa 2.0. Se conserva el tema oscuro (navy + naranja CasaForma). No se toca la lógica de negocio ni el backend.

---

## 1. Objetivos y no-objetivos

### Objetivos
- Que la app se vea moderna ("SaaS actual"), legible y profesional, manteniendo la identidad oscura navy + naranja.
- Dashboard como **resumen básico + accesos rápidos** (no un tablero de analytics pesado).
- Reportes con **datos que realmente sirven** (KPIs, charts, agregaciones útiles, export).
- Sección **Pagos** nueva: historial unificado de cobros (ventas contado + cobranzas de cuenta corriente), inspirada en la pantalla de Pagos del admin de MesaYa 2.0.
- Consistencia: mismo lenguaje visual en todas las pantallas.

### No-objetivos (YAGNI)
- No se cambia la lógica de ventas, cta cte, facturación ni las RPC/migraciones existentes.
- No se agrega tema claro (el usuario eligió mantener el oscuro).
- No se agrega tiempo real (websockets) en Pagos; MesaYa lo usa por su naturaleza, acá el refresh es por query normal.
- No se rediseña el modelo de datos. Pagos lee de tablas ya existentes.
- No se toca la pantalla de login/auth más allá de que ya está limpia.

---

## 2. Sistema de diseño (capa "SaaS moderno" sobre shadcn)

Se mantiene shadcn/ui + Tailwind v4 + los tokens de `src/styles.css` (tema oscuro navy/naranja, colores semánticos primary/success/warning/info/destructive, chart-1..5). Se **evoluciona**, no se reemplaza.

### 2.1 Ajustes de tokens / base (`src/styles.css`)
- Radios ligeramente más suaves para el look moderno (mantener `--radius` ~0.6rem, usar `rounded-2xl` en tarjetas de sección).
- Sombras suaves reutilizables como utilidades (`shadow-card`, `shadow-card-hover`) en vez de sombras inline repetidas.
- Utilidad `stat-chip` para los chips de ícono en color (cuadrado redondeado con fondo tenue del color semántico).
- Conservar la utilidad `kpi-card` existente o reemplazarla por el nuevo `StatCard` (ver abajo).

### 2.2 Componentes presentacionales nuevos (`src/components/app/`)
Cada uno con una única responsabilidad y una interfaz clara. Son de presentación (sin fetching), reciben datos por props.

- **`PageHeader`** — título + subtítulo + slot de acciones (botones) + breadcrumb opcional. Reemplaza los `<h1>` sueltos repetidos en cada página.
  - Props: `title`, `subtitle?`, `badge?`, `actions?: ReactNode`.
- **`StatCard`** — KPI con ícono en chip de color, label, valor grande (`tabular-nums`), sparkline opcional y badge de tendencia opcional (`↑/↓ % vs período anterior`).
  - Props: `label`, `value`, `icon`, `tone` ('primary'|'success'|'warning'|'info'|'destructive'|'muted'), `spark?: number[]`, `trend?: { value: number; positive: boolean; hint?: string }`, `hint?`.
- **`Sparkline`** — SVG polyline chico a partir de un array de números. Sin dependencias.
  - Props: `data: number[]`, `color`, `width?`, `height?`.
- **`SectionCard`** — tarjeta contenedora estándar (título opcional + subtítulo + slot de acciones + children). Usa `rounded-2xl`, borde y `shadow-card`.
  - Props: `title?`, `subtitle?`, `actions?`, `className?`, `children`.
- **`DataTable`** (shell fino) — envoltura sobre la `Table` de shadcn con: header sticky opcional, estado vacío (`emptyText`/`emptyIcon`/`emptyAction?`), estado de carga (skeleton rows con columnas estables), estado de error (`error?`/`onRetry?`) y scroll horizontal contenido. No es una tabla "inteligente" con sorting genérico (YAGNI); cada página define sus columnas.
  - Props: `columns` (para header + skeleton), `children` (filas), `loading?`, `empty?`, `error?`, `onRetry?`.
- **`StatusPill`** — pill de estado con variantes de color (`success`|`warning`|`danger`|`info`|`neutral`) para estados de venta/pago/AFIP.
  - Props: `tone`, `children`, `icon?`.
- **`PeriodFilters`** — barra reutilizable de filtros: rango de fecha (desde/hasta), sucursal, y slots extra. La usan Reportes y Pagos.
  - Props: `from`, `to`, `onFrom`, `onTo`, `sucursalId?`, `onSucursal?`, `sucursales?`, `children?` (filtros extra).
- **`ChartCard`** — solo layout: `SectionCard` (título/subtítulo/acciones) que **compone el `ChartContainer` de shadcn** (`src/components/ui/chart.tsx`, que ya trae `ResponsiveContainer`, tooltip y legend con tokens del tema). No crea una API paralela de charts ni reimplementa la config de recharts.
  - Props: `title`, `subtitle?`, `height?`, `config` (ChartConfig de shadcn), `children` (el chart de recharts).

Estos componentes se testean de forma aislada (render + props) y se reutilizan en todas las pantallas. Cuando una página crece mucho, se extraen sub-componentes a un archivo `-components.tsx` junto a la ruta.

### 2.3 Charts
Se sigue usando `recharts` (ya está). Config de ejes/tooltip/grid centralizada en `ChartCard` y helpers de formato. Tipos de chart usados: línea (tendencia), barras verticales y horizontales, y donut (Pie con innerRadius) para distribución por medio de pago.

---

## 3. App shell (`src/routes/_authenticated/route.tsx`)

- **Sidebar reagrupado** en grupos con `SidebarGroupLabel`:
  - **Operación:** Dashboard · Ventas · Remitos
  - **Catálogo:** Productos · Stock · Clientes
  - **Cobranzas:** Pagos *(nuevo)* · Cuentas corrientes · Rendición caja
  - **Administración:** Reportes · Facturación AFIP · Usuarios *(admin-only, como hoy)*
- Footer del sidebar (usuario, rol, sucursal, salir): se mantiene, se pule el espaciado.
- **Header** de la página: `SidebarTrigger` + breadcrumb (sección actual) + slot de acciones a la derecha. La badge de sucursal se mantiene.
- Se conserva `collapsible="icon"` y el comportamiento actual.

"Rendición caja" y "Pagos" quedan **separadas** (decisión del usuario por defecto): Pagos es histórico/analítico (solo lectura), Rendición caja es operativa. Ambas bajo el grupo "Cobranzas".

---

## 4. Pantallas

### 4.1 Dashboard (`_authenticated/index.tsx`) — resumen + accesos
Objetivo: liviano y accionable. Se **quitan** los charts de 30 días y "por sucursal" (migran a Reportes).

Estructura:
1. **PageHeader** — saludo ("Hola, {nombre}") + subtítulo (sucursal o "Vista global").
2. **Accesos rápidos** — fila de botones/tiles grandes y accesibles: **Nueva venta**, **Cobrar** (→ Pagos/cta cte), **Ver stock**, **Reportes**. (Ícono grande + label, `rounded-2xl`.)
3. **4 StatCards** del período: Ventas hoy, Cobrado hoy, Pendiente hoy, Productos con stock bajo. Con sparkline de los últimos días donde tenga sentido.
4. **Dos columnas compactas:** "Stock bajo" (lista corta con link a Stock) y "Últimas ventas" (lista corta con link a Ventas).

Mantiene el fetching actual (queries a supabase), reordenado. Datos ya disponibles.

### 4.2 Reportes (`_authenticated/reportes.tsx`) — datos útiles
Se mantiene admin-only y los filtros (fecha, sucursal) → se pasan a `MoneyFilters`. Export Excel/PDF existente se conserva.

Estructura:
1. **PageHeader** + `MoneyFilters`.
2. **Fila de StatCards:** Facturado, Cobrado, Pendiente en cta cte (del período/global), Ticket promedio, Cantidad de comprobantes. (Margen queda fuera salvo que haya costo confiable; los productos tienen `precio_fabrica`/`markup`, así que se puede sumar "margen estimado" como StatCard si el dato está — se evalúa en implementación, no es bloqueante.)
3. **Charts:** ventas por día (línea/barras), ventas por sucursal (barras), y **cobrado por medio de pago** (donut). Vía `ChartCard`.
4. **Tabs** (se mantienen): Ventas · Cuentas corrientes · Movimientos de stock — con `DataTable` (estados vacío/carga) y las columnas actuales, más prolijas. Export por tab donde aplique.

### 4.3 Pagos (`_authenticated/pagos.tsx`) — NUEVO, estilo MesaYa 2.0
Sección de **historial de cobros** (solo lectura). Unifica dos fuentes:
- **`venta_pagos`** (pagos de ventas): `forma_pago (enum public.forma_pago), monto, detalle, created_at`. Se consulta **a través de `ventas`** (`ventas.select("fecha, numero_comprobante, tipo_comprobante, cliente:clientes(razon_social), sucursal_id, pagos:venta_pagos(forma_pago, monto)")`) filtrando por **`ventas.fecha`** (tiene índice `idx_ventas_fecha`; `venta_pagos.created_at` no lo tiene) y `estado = ACTIVA`. La fecha del cobro es `ventas.fecha`. Origen = "Venta".
- **`cobranzas_cta_cte`** (cobros de cuenta corriente): `cliente_id, sucursal_id, fecha, monto, forma_pago (text)`, con join a cliente/sucursal, filtrando por `fecha`. Origen = "Cta Cte".

**Fecha canónica:** `ventas.fecha` para pagos de venta y `cobranzas_cta_cte.fecha` para cta cte (fecha contable/caja, consistente con `caja.tsx`). Rangos **half-open** en hora local AR: `[desde 00:00, hasta+1día 00:00)`.

**Signo (importante):** las notas de crédito guardan `monto` **negativo** en `venta_pagos` (devoluciones). Se modela:
```
type Cobro = {
  fecha: string; origen: "VENTA" | "CTA_CTE";
  cliente?: string; sucursalId: string;
  formaPago: FormaPago | string;   // enum conocido o string (cobranzas es text) → label con formaPagoLabel[x] ?? x
  monto: number;                   // firmado: negativo = devolución (NC)
  tipo: "COBRO" | "DEVOLUCION";    // derivado de monto >= 0
  comprobante?: string;
};
```
Se combinan/ordenan por fecha en el cliente. `forma_pago` **no se castea** al enum (cobranzas es `text`); se usa `formaPagoLabel[x] ?? x`.

Estructura (espejo de MesaYa 2.0, adaptado):
1. **PageHeader** con badge "HISTÓRICO" + subtítulo ("N cobros · período").
2. **Filtros** (`PeriodFilters` + extras): rango de fecha, **medio de pago**, **origen** (Todos / Ventas / Cta Cte). El filtro de **sucursal solo se muestra para admin**; el no-admin ve únicamente su sucursal (lo fuerza la RLS). Botón **Exportar** (Excel/CSV).
3. **StatCards** (4): **Total neto cobrado** (Σ montos firmados = cobros − devoluciones), **Efectivo**, **Electrónico** (transf + tarjetas + MP + cheque), **Ticket promedio** (Σ cobros positivos / cantidad de cobros positivos; **excluye devoluciones**). Con sparkline y **tendencia vs período anterior** (segunda query del período previo del mismo largo). Cada card aclara en su `hint` que es neto.
4. **Charts:** donut **Cobrado por medio de pago** (con leyenda + %; usa montos positivos para no distorsionar la distribución) + barras **Cobrado por día** (neto). Vía `ChartCard` → `ChartContainer`.
5. **Tabla paginada responsive:** columnas Fecha · Origen · Cliente · Sucursal · Medio · Monto (las devoluciones se muestran con `StatusPill` "Devolución" y monto en rojo). Card list en mobile, tabla en desktop. **Paginado del lado cliente** (el volumen por período es chico; el rango de fecha ya acota). Pills para origen y medio.

**Permisos y estados:** visible para todos los roles. Para no-admin la RLS filtra por su sucursal (`venta_pagos` por la sucursal de la venta vía `EXISTS`; `cobranzas_cta_cte` por `sucursal_id`). Si el empleado **no tiene sucursal asignada** (`current_sucursal_id()` = null) no lee filas: se muestra un estado vacío explícito ("Tu usuario no tiene sucursal asignada; pedí a un admin que te la asigne") en vez de un cero engañoso.

Ruta nueva: `src/routes/_authenticated/pagos.tsx` (+ entrada en `routeTree.gen.ts` regenerada por el router). Item de menú en grupo "Cobranzas".

### 4.4 Resto de pantallas (refresh, sin cambiar lógica)
Aplican el mismo lenguaje: `PageHeader`, `SectionCard`, `DataTable`, `StatusPill`, densidad y estados consistentes.
- **Ventas** (`ventas.index.tsx`): header + filtros prolijos + `DataTable` con `StatusPill` para estado/AFIP; acciones (ver, emitir, anular) igual que hoy.
- **Nueva venta** (`ventas.nueva.tsx`): mismo formulario y lógica; se pulen tarjetas (Datos generales, Totales, Productos, Pagos) con `SectionCard` y mejor jerarquía. **Sin cambios funcionales.**
- **Productos / Stock / Clientes:** header + `DataTable` + acciones consistentes.
- **Cuentas corrientes** (`cuentas-corrientes.tsx`): header + `DataTable`; el detalle (libro de movimientos + registrar cobro) se re-estiliza con `SectionCard`/`StatusPill`. Lógica intacta.
- **Rendición caja** (`caja.tsx`): refresh visual, sin cambios de lógica.
- **Facturación AFIP** (`facturacion.tsx`): el wizard se envuelve en `SectionCard`s consistentes; lógica intacta.
- **Usuarios** (`usuarios.tsx`): header + `DataTable`.

---

## 5. Consideraciones técnicas

- **SSR:** las rutas autenticadas ya usan `ssr: false`; Pagos también (usa el cliente supabase del browser con RLS, igual que dashboard/reportes). No pasa por server functions → no toca CSRF ni el polyfill.
- **Formato / timezone:** se reutilizan `fmtMoney`, `fmtDateTime`, `formaPagoLabel` de `src/lib/format`. **Antes de usarlos, fijar `America/Argentina/Buenos_Aires`** en los helpers de fecha (hoy `fmtDate`/`fmtDateTime` no fijan tz) — se puede reusar el patrón de `src/lib/fiscal/fecha.ts`, que ya lo hace. Los defaults de rango **no deben** usar `toISOString().slice(0,10)` (se corre de día por UTC); usar un helper de fecha local. Rangos **half-open** `[desde 00:00 local, hasta+1día 00:00 local)`. Si falta un label de medio de pago, se agrega en `formaPagoLabel`.
- **RLS:** todas las tablas leídas (`venta_pagos`, `cobranzas_cta_cte`, `ventas`, etc.) ya tienen políticas para `authenticated`. Confirmado en review: `venta_pagos` filtra por la sucursal de la venta (vía `EXISTS`) y `cobranzas_cta_cte` por `sucursal_id`; un no-admin no lee de más. Caso borde: `current_sucursal_id()` null → no lee filas (ver estado vacío en 4.3).
- **Semántica única de "Cobrado":** "Cobrado" = fondos que entraron = pagos de venta (`venta_pagos`) **+** cobranzas de cta cte (`cobranzas_cta_cte`), **neto de devoluciones**. Pagos, Reportes y el KPI "Cobrado hoy" del Dashboard usan esta misma definición (hoy el dashboard suma solo `ventas.total_pagado`; se alinea para no dar números distintos entre pantallas). Es un ajuste de métrica de UI, no de lógica de negocio.
- **`routeTree.gen.ts` (generado):** no se edita a mano. Para agregar `pagos.tsx`: crear la ruta, correr `bun run dev`/`build` para que el plugin del router regenere el árbol, y commitear el resultado. El `<Link to="/pagos">` del menú solo typechequea **después** de regenerar; por eso Pagos se implementa como una unidad (ruta + regen + menú) antes de correr typecheck.
- **Sin dependencias nuevas:** recharts, lucide, xlsx, jspdf ya están. Sparkline es SVG propio.
- **Accesibilidad:** foco visible, contraste (tema oscuro ya lo cumple), labels en filtros.

---

## 6. Validación / testing

- **Typecheck** (`bun run typecheck`) y **tests** (`bun run test`, 46 actuales) deben seguir en verde. El repo **no tiene** `@testing-library/react` ni `jsdom` y el spec mantiene "sin dependencias nuevas", así que los tests nuevos son de **lógica pura** (funciones extraídas, no render de componentes React): normalización/merge/orden de cobros y totales por medio (Pagos), cálculo de puntos del `Sparkline`, y `computeKpiTrend` (tendencia vs período anterior, incl. casos previo=0/undefined). Los componentes presentacionales se validan por el recorrido Playwright, no por unit test de render.
- **Build** (`bun run build:vercel`) exit 0.
- **Prueba visual con Playwright** contra el build local (como se hizo antes): recorrer dashboard, reportes, pagos, ventas y cta cte; confirmar que renderizan, que los datos cargan y que crear venta / registrar cobro siguen funcionando.

---

## 7. Orden de implementación (rollout)

1. **Design system:** tokens/utilidades en `styles.css` + componentes `src/components/app/*` (con sus tests).
2. **App shell:** sidebar reagrupado + header con breadcrumb.
3. **Pagos** (pantalla nueva) — es la de mayor valor nuevo y valida los componentes.
4. **Dashboard** (simplificar a resumen + accesos).
5. **Reportes** (enriquecer).
6. **Refresh del resto** (ventas, nueva venta, productos, stock, clientes, cta cte, caja, facturación, usuarios) — mecánico y de bajo riesgo.
7. Gate final (typecheck + tests + build + Playwright) y commit/merge.

Cada paso deja la app compilando y navegable.

---

## 8. Criterios de aceptación

- La app mantiene el tema oscuro navy + naranja y toda la funcionalidad actual intacta.
- Dashboard es claramente un resumen con accesos rápidos, sin los charts pesados.
- Reportes muestra KPIs + charts + tablas con export.
- Existe una sección Pagos que lista cobros de ventas y de cta cte, con KPIs, charts por medio de pago y tabla filtrable/exportable.
- Sidebar agrupado; lenguaje visual consistente en todas las pantallas.
- typecheck, tests y build en verde; recorrido Playwright OK.
