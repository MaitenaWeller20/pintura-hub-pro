# Rediseño de UI PinturaGest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar la UI de PinturaGest a un look "SaaS moderno" (tema oscuro navy+naranja), con dashboard de resumen+accesos, reportes enriquecidos y una sección Pagos nueva (historial unificado de cobros), sin tocar la lógica de negocio ni el backend.

**Architecture:** Capa de componentes presentacionales nuevos en `src/components/app/*` sobre shadcn/ui + Tailwind v4. Cada página se re-arma con esos bloques. La lógica de datos vive en las páginas (queries supabase con RLS, `ssr:false`) salvo funciones puras extraídas (normalización de cobros, sparkline, tendencia) que se testean con vitest.

**Tech Stack:** TanStack Start (React 19), shadcn/ui, Tailwind v4, recharts, lucide-react, xlsx, jspdf, Supabase JS, vitest.

## Global Constraints

- No cambiar lógica de negocio, RPC, ni migraciones/backend. Solo UI y métricas de presentación.
- Mantener tema oscuro (navy + naranja CasaForma); sin tema claro.
- Sin dependencias npm nuevas (recharts, lucide, xlsx, jspdf ya están; Sparkline es SVG propio).
- Tests nuevos = solo lógica pura (no render React; no hay jsdom/@testing-library).
- Fechas en `America/Argentina/Buenos_Aires`; rangos half-open `[desde 00:00 local, hasta+1día 00:00 local)`.
- `forma_pago`: enum en `venta_pagos`, `text` en `cobranzas_cta_cte` → nunca castear; label con `formaPagoLabel[x] ?? x`.
- "Cobrado" = `venta_pagos` + `cobranzas_cta_cte`, **neto de devoluciones** (NC guardan monto negativo).
- `routeTree.gen.ts` es generado: no editar a mano; regenerar con dev/build tras agregar rutas.
- Gate por fase: `bun run typecheck`, `bun run test`, y app navegable. Gate final agrega `bun run build:vercel` + recorrido Playwright.
- Cada commit termina con la línea `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Nuevos:**
- `src/lib/dates.ts` — helpers de fecha local AR (hoy, rango, half-open). Testeable.
- `src/lib/pagos.ts` — tipo `Cobro`, normalización/merge/orden y agregados (totales por medio, KPIs, series). Testeable.
- `src/lib/pagos.test.ts`, `src/lib/dates.test.ts`, `src/components/app/sparkline.test.ts` — tests de lógica pura.
- `src/components/app/page-header.tsx`, `stat-card.tsx`, `sparkline.tsx`, `section-card.tsx`, `data-table.tsx`, `status-pill.tsx`, `period-filters.tsx`, `chart-card.tsx`, `trend.ts` (helper `computeKpiTrend`).
- `src/routes/_authenticated/pagos.tsx` — pantalla nueva.

**Modificados:**
- `src/styles.css` — utilidades `shadow-card`, `shadow-card-hover`, `stat-chip`.
- `src/lib/format.ts` — timezone AR en `fmtDate`/`fmtDateTime`; labels faltantes.
- `src/routes/_authenticated/route.tsx` — sidebar agrupado + header con breadcrumb.
- `src/routes/_authenticated/index.tsx` — dashboard resumen+accesos.
- `src/routes/_authenticated/reportes.tsx` — KPIs+charts+tabs.
- `src/routes/_authenticated/{ventas.index,ventas.nueva,productos.index,stock,clientes,cuentas-corrientes,caja,facturacion,usuarios}.tsx` — refresh visual.
- `src/routeTree.gen.ts` — regenerado (no a mano).

---

## Task 1: Helpers de fecha local AR

**Files:**
- Create: `src/lib/dates.ts`
- Test: `src/lib/dates.test.ts`
- Modify: `src/lib/format.ts` (agregar `timeZone` a `fmtDate`/`fmtDateTime`)

**Interfaces:**
- Produces:
  - `AR_TZ = "America/Argentina/Buenos_Aires"`
  - `todayLocalISO(): string` → `"YYYY-MM-DD"` del día actual en AR (sin corrimiento UTC).
  - `daysAgoLocalISO(n: number): string` → `"YYYY-MM-DD"` n días atrás en AR.
  - `rangeToUtc(fromISO: string, toISO: string): { gte: string; lt: string }` → half-open: `gte` = `fromISO`T00:00 AR en ISO UTC, `lt` = (`toISO`+1día) T00:00 AR en ISO UTC.

- [ ] **Step 1: Write the failing test** — `src/lib/dates.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { rangeToUtc, todayLocalISO, daysAgoLocalISO, AR_TZ } from "./dates";

describe("dates", () => {
  it("AR_TZ is Buenos Aires", () => {
    expect(AR_TZ).toBe("America/Argentina/Buenos_Aires");
  });

  it("rangeToUtc is half-open and covers the full local days", () => {
    // AR es UTC-3 (sin DST). 2026-07-10 00:00 AR = 2026-07-10T03:00:00Z
    const { gte, lt } = rangeToUtc("2026-07-10", "2026-07-10");
    expect(gte).toBe("2026-07-10T03:00:00.000Z");
    expect(lt).toBe("2026-07-11T03:00:00.000Z");
  });

  it("todayLocalISO / daysAgoLocalISO return YYYY-MM-DD", () => {
    expect(todayLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(daysAgoLocalISO(30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/dates.test.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Write minimal implementation** — `src/lib/dates.ts`

```ts
// Helpers de fecha ancladas a la zona horaria de Argentina (UTC-3, sin DST),
// para que los rangos de reportes/pagos no se corran de día por UTC.
export const AR_TZ = "America/Argentina/Buenos_Aires";

// AR está fijo en UTC-3. Construimos el instante UTC del inicio de un día local.
function localDayStartUtc(iso: string): Date {
  // iso = "YYYY-MM-DD" (día local AR). 00:00 AR = 03:00 UTC del mismo día.
  return new Date(`${iso}T03:00:00.000Z`);
}

export function todayLocalISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AR_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()); // en-CA => "YYYY-MM-DD"
}

export function daysAgoLocalISO(n: number): string {
  const start = localDayStartUtc(todayLocalISO());
  start.setUTCDate(start.getUTCDate() - n);
  return start.toISOString().slice(0, 10);
}

export function rangeToUtc(fromISO: string, toISO: string): { gte: string; lt: string } {
  const gte = localDayStartUtc(fromISO);
  const lt = localDayStartUtc(toISO);
  lt.setUTCDate(lt.getUTCDate() + 1); // half-open: hasta + 1 día
  return { gte: gte.toISOString(), lt: lt.toISOString() };
}
```

- [ ] **Step 4: Modify `src/lib/format.ts`** — agregar timezone AR

En `fmtDate`, cambiar la llamada a:
```ts
  return dt.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" });
```
En `fmtDateTime`:
```ts
  return dt.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- src/lib/dates.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` (expected: sin errores).
```bash
git add src/lib/dates.ts src/lib/dates.test.ts src/lib/format.ts
git commit -m "feat(ui): helpers de fecha local AR + timezone en formatos"
```

---

## Task 2: Tokens y utilidades del design system

**Files:**
- Modify: `src/styles.css`

**Interfaces:**
- Produces (clases utility): `shadow-card`, `shadow-card-hover`, `stat-chip` (usadas por los componentes de Task 3-4).

- [ ] **Step 1: Agregar utilidades** al final de `src/styles.css` (después de `@utility kpi-card`)

```css
@utility shadow-card {
  box-shadow: 0 1px 3px color-mix(in oklch, black 22%, transparent);
}

@utility shadow-card-hover {
  box-shadow: 0 6px 20px color-mix(in oklch, black 30%, transparent);
}

/* Chip cuadrado redondeado para íconos de KPI, con fondo tenue del color dado.
   Uso: <div class="stat-chip" style="--chip: var(--color-success)"> */
@utility stat-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: var(--radius-lg);
  background: color-mix(in oklch, var(--chip, var(--color-primary)) 16%, var(--color-card));
  color: var(--chip, var(--color-primary));
}
```

- [ ] **Step 2: Verificar build de estilos** — Run: `bun run typecheck` (no rompe TS). Arrancar `bun run dev` un momento y confirmar que la home aún carga sin error de CSS (opcional; el verdadero check visual es en el gate).

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat(ui): utilidades shadow-card y stat-chip"
```

---

## Task 3: Lógica pura de KPIs — Sparkline points + computeKpiTrend

**Files:**
- Create: `src/components/app/sparkline.tsx` (componente + función pura `sparklinePoints`)
- Create: `src/components/app/trend.ts` (`computeKpiTrend`)
- Test: `src/components/app/sparkline.test.ts`

**Interfaces:**
- Produces:
  - `sparklinePoints(data: number[], width?: number, height?: number, pad?: number): string` — string de puntos SVG polyline.
  - `<Sparkline data={number[]} color?={string} width?={number} height?={number} />`
  - `computeKpiTrend(current: number, previous: number | undefined | null): { value: number; positive: boolean } | null`

- [ ] **Step 1: Write the failing test** — `src/components/app/sparkline.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { sparklinePoints } from "./sparkline";
import { computeKpiTrend } from "./trend";

describe("sparklinePoints", () => {
  it("returns a flat baseline for <2 points", () => {
    expect(sparklinePoints([]).split(" ").length).toBeGreaterThanOrEqual(1);
    expect(sparklinePoints([5])).toContain(",");
  });
  it("maps N points to N coordinates within the box", () => {
    const pts = sparklinePoints([0, 5, 10], 52, 18, 2).split(" ");
    expect(pts).toHaveLength(3);
    // primer x = pad, último x = width - pad
    expect(pts[0].startsWith("2")).toBe(true);
    expect(pts[2].split(",")[0]).toBe("50.0");
  });
});

describe("computeKpiTrend", () => {
  it("null when previous is 0/undefined/null", () => {
    expect(computeKpiTrend(10, 0)).toBeNull();
    expect(computeKpiTrend(10, undefined)).toBeNull();
    expect(computeKpiTrend(10, null)).toBeNull();
  });
  it("computes signed percentage", () => {
    expect(computeKpiTrend(150, 100)).toEqual({ value: 50, positive: true });
    expect(computeKpiTrend(50, 100)).toEqual({ value: 50, positive: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/app/sparkline.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/components/app/trend.ts`**

```ts
export function computeKpiTrend(
  current: number,
  previous: number | undefined | null,
): { value: number; positive: boolean } | null {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return { value: Math.abs(Math.round(pct * 10) / 10), positive: pct >= 0 };
}
```

- [ ] **Step 4: Write `src/components/app/sparkline.tsx`**

```tsx
export function sparklinePoints(data: number[], width = 52, height = 18, pad = 2): string {
  if (!data || data.length < 2) {
    const y = (height / 2).toFixed(1);
    return `${pad},${y} ${width - pad},${y}`;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  return data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (width - pad * 2);
      const y = pad + (height - pad * 2) - ((v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function Sparkline({
  data, color = "var(--color-primary)", width = 52, height = 18,
}: { data: number[]; color?: string; width?: number; height?: number }) {
  const points = sparklinePoints(data, width, height);
  const last = points.split(" ").pop()?.split(",") ?? ["0", "0"];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" className="opacity-80">
      <polyline points={points} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test -- src/components/app/sparkline.test.ts` (Expected: PASS, 4 tests).
Run: `bun run typecheck` (Expected: sin errores).

- [ ] **Step 6: Commit**

```bash
git add src/components/app/sparkline.tsx src/components/app/trend.ts src/components/app/sparkline.test.ts
git commit -m "feat(ui): Sparkline (SVG puro) y computeKpiTrend con tests"
```

---

## Task 4: Componentes presentacionales base

**Files:**
- Create: `src/components/app/page-header.tsx`, `stat-card.tsx`, `section-card.tsx`, `status-pill.tsx`, `data-table.tsx`, `period-filters.tsx`, `chart-card.tsx`

**Interfaces:**
- Consumes: `Sparkline` (Task 3), `computeKpiTrend` result, `Card/CardHeader/CardContent` (`@/components/ui/card`), `ChartContainer` (`@/components/ui/chart`), `Table*` (`@/components/ui/table`), `Select*`, `Input`, `Label`.
- Produces:
  - `<PageHeader title subtitle? badge? actions? />`
  - `<StatCard label value icon tone? spark? trend? hint? />` — `tone`: `"primary"|"success"|"warning"|"info"|"destructive"|"muted"`; `trend`: `{ value:number; positive:boolean; hint?:string }`.
  - `<SectionCard title? subtitle? actions? className? >children</SectionCard>`
  - `<StatusPill tone children icon? />` — `tone`: `"success"|"warning"|"danger"|"info"|"neutral"`.
  - `<DataTable columns loading? error? onRetry? empty? >rows</DataTable>` — `columns: string[]` (para header + skeleton), `empty?: { text:string; icon?:ReactNode; action?:ReactNode }`.
  - `<PeriodFilters from to onFrom onTo sucursalId? onSucursal? sucursales? >children</PeriodFilters>`
  - `<ChartCard title subtitle? height? config >chart</ChartCard>`

Cada componente es fino y compone shadcn. Código de referencia (implementar tal cual, ajustando imports):

```tsx
// page-header.tsx
import type { ReactNode } from "react";
export function PageHeader({ title, subtitle, badge, actions }: {
  title: string; subtitle?: string; badge?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
```

```tsx
// stat-card.tsx
import type { ComponentType } from "react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "./sparkline";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
const TONE: Record<string, string> = {
  primary: "var(--color-primary)", success: "var(--color-success)",
  warning: "var(--color-warning)", info: "var(--color-info)",
  destructive: "var(--color-destructive)", muted: "var(--color-muted-foreground)",
};
export function StatCard({ label, value, icon: Icon, tone = "primary", spark, trend, hint }: {
  label: string; value: string; icon: ComponentType<{ className?: string }>;
  tone?: keyof typeof TONE; spark?: number[];
  trend?: { value: number; positive: boolean; hint?: string }; hint?: string;
}) {
  const color = TONE[tone];
  const TrendIcon = trend?.positive ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="p-5 shadow-card hover:shadow-card-hover transition-shadow">
      <div className="flex items-start justify-between">
        <div className="stat-chip" style={{ ["--chip" as string]: color }}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        {spark && <Sparkline data={spark} color={color} />}
      </div>
      <p className="text-sm text-muted-foreground mt-3">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums mt-0.5">{value}</p>
      {trend && (
        <div className="flex items-center gap-1 mt-2">
          <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
            style={{ color, background: `color-mix(in oklch, ${color} 15%, transparent)` }}>
            <TrendIcon className="h-3 w-3" />{trend.value}%
          </span>
          {trend.hint && <span className="text-[11px] text-muted-foreground">{trend.hint}</span>}
        </div>
      )}
      {hint && !trend && <p className="text-[11px] text-muted-foreground mt-2">{hint}</p>}
    </Card>
  );
}
```

```tsx
// section-card.tsx
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
export function SectionCard({ title, subtitle, actions, className, children }: {
  title?: string; subtitle?: string; actions?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <Card className={cn("p-5 shadow-card", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            {title && <h3 className="font-semibold text-sm">{title}</h3>}
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </Card>
  );
}
```

```tsx
// status-pill.tsx
import type { ReactNode } from "react";
const TONE: Record<string, string> = {
  success: "text-success border-success/30 bg-success/10",
  warning: "text-warning border-warning/30 bg-warning/10",
  danger: "text-destructive border-destructive/30 bg-destructive/10",
  info: "text-info border-info/30 bg-info/10",
  neutral: "text-muted-foreground border-border bg-muted",
};
export function StatusPill({ tone = "neutral", children, icon }: {
  tone?: keyof typeof TONE; children: ReactNode; icon?: ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${TONE[tone]}`}>
      {icon}{children}
    </span>
  );
}
```

```tsx
// data-table.tsx
import type { ReactNode } from "react";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
export function DataTable({ columns, children, loading, error, onRetry, empty }: {
  columns: string[]; children: ReactNode; loading?: boolean; error?: string;
  onRetry?: () => void; empty?: { text: string; icon?: ReactNode; action?: ReactNode };
}) {
  const body = () => {
    if (loading) return [...Array(5)].map((_, i) => (
      <TableRow key={i}>{columns.map((c, j) => (
        <TableCell key={j}><div className="h-4 rounded bg-muted animate-pulse" /></TableCell>
      ))}</TableRow>
    ));
    if (error) return (
      <TableRow><TableCell colSpan={columns.length} className="text-center py-8 text-sm text-destructive">
        {error} {onRetry && <Button size="sm" variant="outline" className="ml-2" onClick={onRetry}>Reintentar</Button>}
      </TableCell></TableRow>
    );
    return children;
  };
  return (
    <div className="rounded-2xl border border-border overflow-hidden shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            {columns.map((c) => <TableHead key={c}>{c}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>{body()}</TableBody>
        </Table>
      </div>
    </div>
  );
}
```
(La página decide cuándo mostrar el estado vacío `empty`: si no está `loading`/`error` y no hay filas, renderiza una fila `colSpan` con `empty.text`/`empty.icon`/`empty.action`. Se puede exponer un helper `EmptyRow` en el mismo archivo.)

```tsx
// period-filters.tsx
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export function PeriodFilters({ from, to, onFrom, onTo, sucursalId, onSucursal, sucursales, children }: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void;
  sucursalId?: string; onSucursal?: (v: string) => void;
  sucursales?: Array<{ id: string; nombre: string }>; children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div><Label className="text-xs">Desde</Label><Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="w-auto" /></div>
      <div><Label className="text-xs">Hasta</Label><Input type="date" value={to} onChange={(e) => onTo(e.target.value)} className="w-auto" /></div>
      {sucursales && onSucursal && (
        <div><Label className="text-xs">Sucursal</Label>
          <Select value={sucursalId || "__all__"} onValueChange={(v) => onSucursal(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas</SelectItem>
              {sucursales.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {children}
    </div>
  );
}
```

```tsx
// chart-card.tsx
import type { ReactNode } from "react";
import { SectionCard } from "./section-card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
export function ChartCard({ title, subtitle, height = 260, config, children }: {
  title: string; subtitle?: string; height?: number; config: ChartConfig; children: ReactNode;
}) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <ChartContainer config={config} style={{ height }} className="w-full">
        {children as any}
      </ChartContainer>
    </SectionCard>
  );
}
```

- [ ] **Step 1:** Crear los 7 archivos con el código de arriba.
- [ ] **Step 2:** Run `bun run typecheck` — Expected: sin errores (ajustar imports/tipos si `ChartContainer` exige un único child; ver `src/components/ui/chart.tsx`).
- [ ] **Step 3: Commit**

```bash
git add src/components/app/
git commit -m "feat(ui): componentes base (PageHeader, StatCard, SectionCard, StatusPill, DataTable, PeriodFilters, ChartCard)"
```

---

## Task 5: App shell — sidebar agrupado + header con breadcrumb

**Files:**
- Modify: `src/routes/_authenticated/route.tsx`

**Interfaces:**
- Consumes: componentes shadcn `Sidebar*` ya usados.

- [ ] **Step 1:** Reemplazar el array `menu` plano por grupos:

```tsx
const groups = [
  { label: "Operación", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, adminOnly: false },
    { to: "/ventas", label: "Ventas", icon: ShoppingCart, adminOnly: false },
    { to: "/remitos", label: "Remitos", icon: Truck, adminOnly: false },
  ]},
  { label: "Catálogo", items: [
    { to: "/productos", label: "Productos", icon: Package, adminOnly: false },
    { to: "/stock", label: "Stock", icon: Boxes, adminOnly: false },
    { to: "/clientes", label: "Clientes", icon: Users, adminOnly: false },
  ]},
  { label: "Cobranzas", items: [
    { to: "/pagos", label: "Pagos", icon: Wallet, adminOnly: false },
    { to: "/cuentas-corrientes", label: "Cuentas corrientes", icon: Receipt, adminOnly: false },
    { to: "/caja", label: "Rendición caja", icon: Coins, adminOnly: false },
  ]},
  { label: "Administración", items: [
    { to: "/reportes", label: "Reportes", icon: BarChart3, adminOnly: true },
    { to: "/facturacion", label: "Facturación AFIP", icon: FileCheck2, adminOnly: true },
    { to: "/usuarios", label: "Usuarios", icon: UserCog, adminOnly: true },
  ]},
];
```
(Importar `Boxes`, `Coins` de lucide-react; quitar imports no usados.) Renderizar un `SidebarGroup` por grupo (mismo patrón actual con `SidebarGroupLabel` + `map`). El activo: `item.to === "/" ? path === "/" : path.startsWith(item.to)`.

- [ ] **Step 2:** En el `<header>`, agregar breadcrumb simple con el label de la ruta activa (buscar en `groups` el item cuyo `to` matchea `path`), a la derecha del `SidebarTrigger`. Mantener la badge de sucursal.

- [ ] **Step 3:** Run `bun run typecheck`. Arrancar `bun run dev`, entrar con un usuario y verificar que el sidebar muestra los 4 grupos y navega. (El item "Pagos" apuntará a `/pagos`, que aún no existe hasta Task 7; hasta entonces dejar el item comentado o esperar a Task 7 para descomentarlo. **Decisión:** agregar el item "Pagos" recién en Task 7 para no romper typecheck del `<Link to="/pagos">`.)

Nota: en este Task, dejar el grupo "Cobranzas" **sin** el item Pagos (o con `to="/cuentas-corrientes"`); Pagos se suma en Task 7 tras regenerar el routeTree.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authenticated/route.tsx
git commit -m "feat(ui): sidebar agrupado (Operación/Catálogo/Cobranzas/Administración) + breadcrumb"
```

---

## Task 6: Lógica de Pagos — tipo Cobro, normalización y agregados

**Files:**
- Create: `src/lib/pagos.ts`
- Test: `src/lib/pagos.test.ts`

**Interfaces:**
- Produces:
  - `type Cobro = { fecha: string; origen: "VENTA" | "CTA_CTE"; cliente?: string; sucursalId: string; formaPago: string; monto: number; tipo: "COBRO" | "DEVOLUCION"; comprobante?: string }`
  - `type VentaRow = { fecha: string; numero_comprobante: string; sucursal_id: string; cliente?: { razon_social?: string | null } | null; pagos: Array<{ forma_pago: string; monto: number | string }> }`
  - `type CobranzaRow = { fecha: string; sucursal_id: string; forma_pago: string; monto: number | string; cliente?: { razon_social?: string | null } | null }`
  - `normalizarCobros(ventas: VentaRow[], cobranzas: CobranzaRow[]): Cobro[]` — merge + orden desc por fecha; `tipo` = `monto >= 0 ? "COBRO" : "DEVOLUCION"`.
  - `totalesPorMedio(cobros: Cobro[]): Array<{ formaPago: string; total: number }>` — suma firmada por medio, orden desc por total, solo medios con total != 0.
  - `resumenPagos(cobros: Cobro[]): { totalNeto: number; efectivo: number; electronico: number; ticketPromedio: number; cantidad: number }` — `totalNeto` = Σ firmada; `efectivo` = Σ EFECTIVO firmada; `electronico` = Σ (TRANSFERENCIA, TARJETA_CREDITO, TARJETA_DEBITO, MERCADO_PAGO, CHEQUE) firmada; `ticketPromedio` = Σ(cobros positivos)/cantidad(cobros positivos) (excluye devoluciones); `cantidad` = cobros positivos.
  - `serieDiaria(cobros: Cobro[]): Array<{ fecha: string; total: number }>` — agrupa por día local (usar `fmtDate`), suma firmada, orden ascendente.

- [ ] **Step 1: Write the failing test** — `src/lib/pagos.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalizarCobros, totalesPorMedio, resumenPagos } from "./pagos";

const ventas = [
  { fecha: "2026-07-10T15:00:00Z", numero_comprobante: "OHI-FVTA-0001", sucursal_id: "s1",
    cliente: { razon_social: "Cliente A" }, pagos: [{ forma_pago: "EFECTIVO", monto: 1000 }] },
  { fecha: "2026-07-11T15:00:00Z", numero_comprobante: "OHI-NCIV-0001", sucursal_id: "s1",
    cliente: { razon_social: "Cliente A" }, pagos: [{ forma_pago: "EFECTIVO", monto: -400 }] }, // NC (devolución)
];
const cobranzas = [
  { fecha: "2026-07-10T16:00:00Z", sucursal_id: "s1", forma_pago: "TRANSFERENCIA", monto: 500,
    cliente: { razon_social: "Cliente B" } },
];

describe("normalizarCobros", () => {
  it("merges both sources, sets tipo by sign, sorts desc", () => {
    const c = normalizarCobros(ventas as any, cobranzas as any);
    expect(c).toHaveLength(3);
    expect(c[0].fecha >= c[1].fecha).toBe(true); // orden desc
    const nc = c.find((x) => x.monto < 0)!;
    expect(nc.tipo).toBe("DEVOLUCION");
    expect(c.find((x) => x.origen === "CTA_CTE")?.formaPago).toBe("TRANSFERENCIA");
  });
});

describe("totalesPorMedio", () => {
  it("sums signed by medio", () => {
    const t = totalesPorMedio(normalizarCobros(ventas as any, cobranzas as any));
    expect(t.find((x) => x.formaPago === "EFECTIVO")?.total).toBe(600); // 1000 - 400
    expect(t.find((x) => x.formaPago === "TRANSFERENCIA")?.total).toBe(500);
  });
});

describe("resumenPagos", () => {
  it("net total, ticket excludes devoluciones", () => {
    const r = resumenPagos(normalizarCobros(ventas as any, cobranzas as any));
    expect(r.totalNeto).toBe(1100);      // 1000 - 400 + 500
    expect(r.efectivo).toBe(600);
    expect(r.electronico).toBe(500);
    expect(r.cantidad).toBe(2);          // dos cobros positivos (venta 1000, cobranza 500)
    expect(r.ticketPromedio).toBe(750);  // (1000 + 500) / 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `bun run test -- src/lib/pagos.test.ts` → FAIL.

- [ ] **Step 3: Write `src/lib/pagos.ts`** (implementar según Interfaces arriba; `monto` con `Number(...)`; `serieDiaria`/`totalesPorMedio` con `Map`).

- [ ] **Step 4: Run tests + typecheck** — Run: `bun run test -- src/lib/pagos.test.ts` (PASS) y `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pagos.ts src/lib/pagos.test.ts
git commit -m "feat(pagos): normalización y agregados de cobros (venta_pagos + cobranzas) con tests"
```

---

## Task 7: Pantalla Pagos + ruta + menú

**Files:**
- Create: `src/routes/_authenticated/pagos.tsx`
- Modify: `src/routes/_authenticated/route.tsx` (agregar item "Pagos")
- Regenerate: `src/routeTree.gen.ts` (vía dev/build)

**Interfaces:**
- Consumes: `PageHeader, StatCard, ChartCard, PeriodFilters, DataTable, StatusPill` (Task 4), `normalizarCobros, resumenPagos, totalesPorMedio, serieDiaria` (Task 6), `computeKpiTrend` (Task 3), `rangeToUtc, todayLocalISO, daysAgoLocalISO` (Task 1), `useCurrentUser`, `supabase`.

- [ ] **Step 1: Crear `src/routes/_authenticated/pagos.tsx`** (`ssr:false`). Estado: `from` (default `daysAgoLocalISO(30)`), `to` (`todayLocalISO()`), `sucId`, `medio`, `origen`. Dos `useQuery`:
  - período actual: consultar `ventas` (`select("fecha, numero_comprobante, sucursal_id, cliente:clientes(razon_social), pagos:venta_pagos(forma_pago, monto)")` con `estado=ACTIVA`, `fecha` en `rangeToUtc(from,to)`; filtrar `sucursal_id` si admin+sucId o si no-admin por su sucursal vía RLS) y `cobranzas_cta_cte` (`select("fecha, sucursal_id, forma_pago, monto, cliente:clientes(razon_social)")` mismo rango). `normalizarCobros(...)`. Aplicar filtros cliente `medio`/`origen`.
  - período anterior (mismo largo, para tendencia): igual pero rango `[from - len, from)`; solo se usa `resumenPagos` para `computeKpiTrend`.
- [ ] **Step 2:** Render: `PageHeader` (badge `StatusPill` "HISTÓRICO", subtítulo `${cantidad} cobros · período`), `PeriodFilters` (sucursal **solo admin**) + selects de medio/origen + botón Exportar (xlsx, patrón de `reportes.tsx`). Fila de 4 `StatCard` (Total neto, Efectivo, Electrónico, Ticket prom.) con `spark` de `serieDiaria` y `trend` vs período anterior. `ChartCard` donut (medios, positivos) + `ChartCard` barras (serie diaria). `DataTable` columns `["Fecha","Origen","Cliente","Sucursal","Medio","Monto"]` con `StatusPill` para origen/devolución; paginado cliente (10/pág). Estado vacío: si no-admin sin sucursal, texto explícito.
- [ ] **Step 3: Agregar item Pagos al menú** en `route.tsx` grupo "Cobranzas": `{ to: "/pagos", label: "Pagos", icon: Wallet, adminOnly: false }` como primer item.
- [ ] **Step 4: Regenerar routeTree** — Run: `bun run build` (o `bun run dev` unos segundos). Confirmar que `src/routeTree.gen.ts` ahora incluye `pagos`. NO editarlo a mano.
- [ ] **Step 5: Typecheck + tests** — `bun run typecheck` (el `<Link to="/pagos">` ahora typechequea) y `bun run test` (46+ en verde).
- [ ] **Step 6: Commit**

```bash
git add src/routes/_authenticated/pagos.tsx src/routes/_authenticated/route.tsx src/routeTree.gen.ts
git commit -m "feat(pagos): pantalla de historial de cobros (KPIs, charts, tabla filtrable) + ruta y menú"
```

---

## Task 8: Dashboard — resumen + accesos

**Files:**
- Modify: `src/routes/_authenticated/index.tsx`

- [ ] **Step 1:** Reescribir el render con `PageHeader` ("Hola, {nombre}"), una fila de **accesos rápidos** (4 tiles `SectionCard`/`Link` grandes: Nueva venta, Cobrar → `/pagos`, Ver stock, Reportes), 4 `StatCard` (Ventas hoy, Cobrado hoy [=venta_pagos+cobranzas del día, ver Global Constraints], Pendiente hoy, Stock bajo) con `spark` de últimos 7 días, y 2 `SectionCard` compactas (Stock bajo, Últimas ventas). **Quitar** los charts de 30d y por-sucursal (van a Reportes). Reusar/ajustar el `queryFn` actual (agregar suma de `cobranzas_cta_cte` del día para "Cobrado hoy").
- [ ] **Step 2:** Run `bun run typecheck` + `bun run test`.
- [ ] **Step 3:** `bun run dev`, verificar dashboard liviano y accesos.
- [ ] **Step 4: Commit** — `git commit -m "feat(ui): dashboard como resumen + accesos rápidos"`

---

## Task 9: Reportes — KPIs + charts + tabs

**Files:**
- Modify: `src/routes/_authenticated/reportes.tsx`

- [ ] **Step 1:** Encabezar con `PageHeader` + `PeriodFilters`. Agregar fila de `StatCard` (Facturado, Cobrado, Pendiente cta cte, Ticket promedio, Cantidad). Agregar charts vía `ChartCard`: ventas por día (line/bar), por sucursal (bar), cobrado por medio (donut, reusar `totalesPorMedio` de `pagos.ts` sobre las ventas del período + cobranzas). Migrar las 3 tabs existentes a `DataTable`. Conservar export xlsx/pdf.
- [ ] **Step 2:** Run `bun run typecheck` + `bun run test`.
- [ ] **Step 3:** `bun run dev`, verificar (admin) filtros, KPIs, charts, export.
- [ ] **Step 4: Commit** — `git commit -m "feat(ui): reportes con KPIs, charts y tablas con export"`

---

## Task 10: Refresh del resto de pantallas

**Files (una sub-tarea por archivo, commit por archivo):**
- `src/routes/_authenticated/ventas.index.tsx` — `PageHeader` + filtros + `DataTable` + `StatusPill` (estado/AFIP). Sin cambios de acciones/lógica.
- `src/routes/_authenticated/ventas.nueva.tsx` — envolver secciones en `SectionCard`, pulir jerarquía. **Sin cambios funcionales** (verificar que crear venta sigue igual).
- `src/routes/_authenticated/productos.index.tsx` — `PageHeader` + `DataTable`.
- `src/routes/_authenticated/stock.tsx` — `PageHeader` + `DataTable`.
- `src/routes/_authenticated/clientes.tsx` — `PageHeader` + `DataTable`.
- `src/routes/_authenticated/cuentas-corrientes.tsx` — `PageHeader` + `DataTable`; detalle (libro + registrar cobro) con `SectionCard`/`StatusPill`. Lógica intacta.
- `src/routes/_authenticated/caja.tsx` — refresh visual, lógica intacta.
- `src/routes/_authenticated/facturacion.tsx` — envolver el wizard en `SectionCard`s. Lógica intacta.
- `src/routes/_authenticated/usuarios.tsx` — `PageHeader` + `DataTable`.

- [ ] Para **cada** archivo: aplicar los componentes, `bun run typecheck`, verificar en `bun run dev` que la pantalla funciona igual, y commit `git commit -m "refresh(ui): <pantalla>"`.
- [ ] Tras todos: `bun run test` (46+ verde).

---

## Task 11: Gate final + merge

- [ ] **Step 1:** `bun run typecheck` (sin errores).
- [ ] **Step 2:** `bun run test` (todos verde, incl. los nuevos de dates/sparkline/pagos).
- [ ] **Step 3:** `NITRO_PRESET=node-server bun run build` (exit 0). Levantar `.output/server/index.mjs` en un puerto libre con `.env` local apuntando a Supabase local.
- [ ] **Step 4: Recorrido Playwright** (login QA): dashboard (accesos+KPIs), pagos (KPIs/charts/tabla/filtros), reportes, ventas (crear una venta contado y una cta cte OK), cuentas-corrientes (registrar cobro OK). Confirmar que ninguna server function 500 y que los datos cargan.
- [ ] **Step 5:** `bun run build:vercel` (exit 0).
- [ ] **Step 6:** Restaurar `.env` a producción (desde `.env.prod.bak`). Merge de la rama a `main` (`--no-ff`).

---

## Self-Review

- **Cobertura del spec:** design system (Task 2-4) ✓; shell/IA (Task 5) ✓; Pagos con modelo de datos, signo NC, fecha canónica, RLS sin-sucursal, forma_pago text (Task 6-7) ✓; dashboard resumen+accesos (Task 8) ✓; reportes KPIs+charts (Task 9) ✓; refresh resto (Task 10) ✓; semántica "Cobrado" unificada (Task 6 lógica + Task 8/9 uso) ✓; timezone AR + half-open (Task 1) ✓; tests de lógica pura (Task 1,3,6) ✓; ChartCard compone ChartContainer (Task 4) ✓; routeTree regen (Task 7) ✓; gate + Playwright (Task 11) ✓.
- **Placeholders:** ninguno; funciones con código o interfaz exacta.
- **Consistencia de tipos:** `Cobro`/`resumenPagos`/`totalesPorMedio`/`serieDiaria` usados igual en Task 6 (def), 7 y 9. `computeKpiTrend` firma estable Task 3 → 7. `rangeToUtc` firma estable Task 1 → 7.
