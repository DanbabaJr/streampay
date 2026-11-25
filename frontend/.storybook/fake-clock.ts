/**
 * Injected fake clock for stories and visual baselines.
 *
 * Live accrual is computed from the wall clock: the stream detail ticker
 * re-reads `Date.now()` every second (lib/live-accrual.ts), the stream form
 * previews against "now", and the toast ids are timestamped. Left alone, two
 * renders of the same story a second apart produce two different pixels and a
 * screenshot diff that is noise. Every story therefore runs against a frozen
 * `Date`: `new Date()` and `Date.now()` both answer `FIXED_NOW_MS` until the
 * story advances the clock itself with `tick()`.
 *
 * Only `Date` is replaced. `setTimeout` / `setInterval` keep running in real
 * time, so React, Storybook's own scheduling and the accrual ticker all still
 * fire — they just observe the same instant on every tick, which is exactly
 * the property a pixel baseline needs. A frozen-at-instant clock is also the
 * reason no fake-timer library is pulled in: `@sinonjs/fake-timers` `require`s
 * Node built-ins that the Vite browser bundle cannot load.
 */

/** 2026-01-15T12:00:00Z — inside every fixture stream's window. */
export const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/** The same instant in ledger seconds, for building fixture streams. */
export const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

export interface FakeClock {
  /** Current fake time in milliseconds since the epoch. */
  now(): number;
  /** Moves the frozen clock forward (or back, with a negative value). */
  tick(ms: number): void;
  /** Restores the real `Date`. Idempotent. */
  uninstall(): void;
}

let active: FakeClock | null = null;

/**
 * Where the installed clock is published for the visual suite, which drives
 * it from Playwright (visual/detector.visual.ts) to prove the counter really
 * is clock-driven and not merely static.
 */
export const CLOCK_GLOBAL = "__STREAMPAY_FAKE_CLOCK__";

type ClockHost = typeof globalThis & { [CLOCK_GLOBAL]?: FakeClock };

export function installFakeClock(startMs: number = FIXED_NOW_MS): FakeClock {
  active?.uninstall();

  const RealDate = globalThis.Date;
  let nowMs = startMs;

  // A subclass, not a wrapper object: `instanceof Date`, `Date.UTC`,
  // `Date.parse` and every prototype method keep working unchanged.
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(nowMs);
      } else {
        // Explicit timestamps / date strings are not "now" and pass through.
        super(...(args as ConstructorParameters<DateConstructor>));
      }
    }

    static now(): number {
      return nowMs;
    }
  }

  globalThis.Date = FakeDate as DateConstructor;

  const clock: FakeClock = {
    now: () => nowMs,
    tick(ms) {
      nowMs += ms;
    },
    uninstall() {
      if (globalThis.Date === (FakeDate as DateConstructor)) {
        globalThis.Date = RealDate;
      }
      if (active === clock) active = null;
      const host = globalThis as ClockHost;
      if (host[CLOCK_GLOBAL] === clock) delete host[CLOCK_GLOBAL];
    },
  };
  active = clock;
  (globalThis as ClockHost)[CLOCK_GLOBAL] = clock;
  return clock;
}
