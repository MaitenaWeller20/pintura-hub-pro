import type { ReactElement } from "react";
import { SectionCard } from "./section-card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

export function ChartCard({
  title,
  subtitle,
  height = 260,
  config,
  children,
}: {
  title: string;
  subtitle?: string;
  height?: number;
  config: ChartConfig;
  children: ReactElement;
}) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <ChartContainer config={config} style={{ height }} className="w-full">
        {children}
      </ChartContainer>
    </SectionCard>
  );
}
