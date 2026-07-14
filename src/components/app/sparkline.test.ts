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
