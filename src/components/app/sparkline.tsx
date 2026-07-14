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
  data,
  color = "var(--color-primary)",
  width = 52,
  height = 18,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const points = sparklinePoints(data, width, height);
  const last = points.split(" ").pop()?.split(",") ?? ["0", "0"];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" className="opacity-80">
      <polyline
        points={points}
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}
