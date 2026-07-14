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

  it("rangeToUtc spans multiple days half-open", () => {
    const { gte, lt } = rangeToUtc("2026-07-01", "2026-07-31");
    expect(gte).toBe("2026-07-01T03:00:00.000Z");
    expect(lt).toBe("2026-08-01T03:00:00.000Z");
  });

  it("todayLocalISO / daysAgoLocalISO return YYYY-MM-DD", () => {
    expect(todayLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(daysAgoLocalISO(30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
