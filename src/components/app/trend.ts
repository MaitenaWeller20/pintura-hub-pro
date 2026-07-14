export function computeKpiTrend(
  current: number,
  previous: number | undefined | null,
): { value: number; positive: boolean } | null {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return { value: Math.abs(Math.round(pct * 10) / 10), positive: pct >= 0 };
}
