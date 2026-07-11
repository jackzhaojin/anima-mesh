/**
 * DST-correct daily alarm math — the reason the schedule is a DO alarm and
 * not a UTC-fixed cron trigger. No Temporal on Workers yet; no date
 * libraries (zero deps): the two-pass Intl offset trick, converging on the
 * epoch instant whose wall clock in `tz` reads `hour`:00:00.
 */
function tzParts(epochMs: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(epochMs).map((x) => [x.type, x.value]));
  return {
    y: +p.year!,
    mo: +p.month!,
    d: +p.day!,
    h: +(p.hour === "24" ? 0 : p.hour!),
    mi: +p.minute!,
    s: +p.second!,
  };
}

/** Epoch ms at which local time in `tz` next reads `hour`:00:00 (strictly after `now`). */
export function nextBeatUtc(now: Date, tz: string, hour: number): number {
  const nowMs = now.getTime();
  const p = tzParts(nowMs, tz);

  // Target local calendar date: today if hour:00 is still strictly ahead,
  // else tomorrow (at exactly hour:00:00 the beat is firing NOW — arm the
  // next one, never a zero-delay double-fire).
  const needTomorrow = p.h >= hour;
  // Date.UTC normalizes day overflow (Jul 32 → Aug 1).
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + (needTomorrow ? 1 : 0)));
  const ty = t.getUTCFullYear();
  const tm = t.getUTCMonth();
  const td = t.getUTCDate();
  const targetAsUtc = Date.UTC(ty, tm, td, hour, 0, 0);

  // First guess: pretend the local wall time IS UTC, then converge.
  let guess = targetAsUtc;
  for (let i = 0; i < 4; i++) {
    const q = tzParts(guess, tz);
    const guessLocalAsUtc = Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s);
    const diff = targetAsUtc - guessLocalAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}
