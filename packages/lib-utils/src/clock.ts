// Clock dependency injection — the clock is a dependency.
// `new Date()` / `Date.now()` is forbidden in business logic
// (engineering principles). Use the injected Clock.

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const SystemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now()
};

/**
 * Create a fixed clock for tests. `tick(ms)` advances time deterministically.
 */
export function fakeClock(initial: Date | number = 0): Clock & { tick(ms: number): void; set(d: Date | number): void } {
  let t = typeof initial === "number" ? initial : initial.getTime();
  return {
    now: () => new Date(t),
    nowMs: () => t,
    tick: (ms: number) => {
      t += ms;
    },
    set: (d: Date | number) => {
      t = typeof d === "number" ? d : d.getTime();
    }
  };
}
