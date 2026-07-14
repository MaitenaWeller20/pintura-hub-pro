import type { ReactNode } from "react";

const TONE = {
  success: "text-success border-success/30 bg-success/10",
  warning: "text-warning border-warning/30 bg-warning/10",
  danger: "text-destructive border-destructive/30 bg-destructive/10",
  info: "text-info border-info/30 bg-info/10",
  neutral: "text-muted-foreground border-border bg-muted",
} as const;

export function StatusPill({
  tone = "neutral",
  children,
  icon,
}: {
  tone?: keyof typeof TONE;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${TONE[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}
