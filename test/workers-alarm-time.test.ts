import { describe, it, expect } from "vitest";
import { nextBeatUtc } from "../workers/heartbeat/src/alarm-time.js";

const TZ = "America/New_York";

/** Wall clock in tz at an epoch, "HH:MM" + ISO date, for readable asserts. */
function wallClock(epochMs: number, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(epochMs).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

describe("nextBeatUtc", () => {
  it("before 08:00 ET → today 08:00 ET", () => {
    // 2026-07-15T06:00 ET = 10:00 UTC (EDT, -4)
    const now = new Date("2026-07-15T10:00:00Z");
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-07-15", time: "08:00" });
    expect(next).toBe(Date.parse("2026-07-15T12:00:00Z"));
  });

  it("after 08:00 ET → tomorrow 08:00 ET", () => {
    // 2026-07-15T09:30 ET = 13:30 UTC
    const now = new Date("2026-07-15T13:30:00Z");
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-07-16", time: "08:00" });
  });

  it("exactly 08:00:00 ET → tomorrow (strictly after)", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-07-16", time: "08:00" });
  });

  it("UTC-noon 'now' lands correctly relative to 08:00 ET (EDT: noon UTC = 08:00 ET)", () => {
    // Noon UTC in January = 07:00 ET (EST, -5): beat is still ahead today.
    const winterNoon = new Date("2026-01-15T12:00:00Z");
    expect(wallClock(nextBeatUtc(winterNoon, TZ, 8), TZ)).toEqual({ date: "2026-01-15", time: "08:00" });
    expect(nextBeatUtc(winterNoon, TZ, 8)).toBe(Date.parse("2026-01-15T13:00:00Z"));
  });

  it("spring-forward day (2026-03-08 US): 08:00 ET exists and is EDT", () => {
    // 05:00 UTC = 00:00 EST on Mar 8; DST jumps 02:00→03:00 that morning.
    const now = new Date("2026-03-08T05:00:00Z");
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-03-08", time: "08:00" });
    expect(next).toBe(Date.parse("2026-03-08T12:00:00Z")); // EDT = UTC-4
  });

  it("fall-back day (2026-11-01 US): 08:00 ET is EST again", () => {
    const now = new Date("2026-11-01T04:00:00Z"); // 00:00 EDT
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-11-01", time: "08:00" });
    expect(next).toBe(Date.parse("2026-11-01T13:00:00Z")); // EST = UTC-5
  });

  it("crossing spring-forward: armed the evening before fires at 08:00 EDT, ~23h later", () => {
    const now = new Date("2026-03-08T01:00:00Z"); // Mar 7, 20:00 EST
    const next = nextBeatUtc(now, TZ, 8);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-03-08", time: "08:00" });
  });

  it("BEAT_HOUR=0 edge: next local midnight", () => {
    const now = new Date("2026-07-15T13:30:00Z"); // 09:30 ET
    const next = nextBeatUtc(now, TZ, 0);
    expect(wallClock(next, TZ)).toEqual({ date: "2026-07-16", time: "00:00" });
  });

  it("works for a UTC-plus zone too (Europe/Berlin)", () => {
    const now = new Date("2026-07-15T05:00:00Z"); // 07:00 CEST
    const next = nextBeatUtc(now, "Europe/Berlin", 8);
    expect(wallClock(next, "Europe/Berlin")).toEqual({ date: "2026-07-15", time: "08:00" });
    expect(next).toBe(Date.parse("2026-07-15T06:00:00Z"));
  });

  it("always strictly in the future", () => {
    for (const iso of ["2026-03-08T11:59:00Z", "2026-11-01T12:59:00Z", "2026-06-30T23:59:00Z"]) {
      const now = new Date(iso);
      expect(nextBeatUtc(now, TZ, 8)).toBeGreaterThan(now.getTime());
    }
  });
});
