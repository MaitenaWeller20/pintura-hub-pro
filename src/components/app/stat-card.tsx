import type { ComponentType, CSSProperties } from "react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "./sparkline";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

const TONE = {
  primary: "var(--color-primary)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  info: "var(--color-info)",
  destructive: "var(--color-destructive)",
  muted: "var(--color-muted-foreground)",
} as const;

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  spark,
  trend,
  hint,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: keyof typeof TONE;
  spark?: number[];
  trend?: { value: number; positive: boolean; hint?: string };
  hint?: string;
}) {
  const color = TONE[tone];
  const TrendIcon = trend?.positive ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="p-5 shadow-card hover:shadow-card-hover transition-shadow">
      <div className="flex items-start justify-between">
        <div className="stat-chip" style={{ "--chip": color } as CSSProperties}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        {spark && spark.length > 0 && <Sparkline data={spark} color={color} />}
      </div>
      <p className="text-sm text-muted-foreground mt-3">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums mt-0.5">{value}</p>
      {trend && (
        <div className="flex items-center gap-1 mt-2">
          <span
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
            style={{ color, background: `color-mix(in oklch, ${color} 15%, transparent)` }}
          >
            <TrendIcon className="h-3 w-3" />
            {trend.value}%
          </span>
          {trend.hint && <span className="text-[11px] text-muted-foreground">{trend.hint}</span>}
        </div>
      )}
      {hint && !trend && <p className="text-[11px] text-muted-foreground mt-2">{hint}</p>}
    </Card>
  );
}
