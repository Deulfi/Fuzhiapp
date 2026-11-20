/**
 * Timing knobs for behaviour that depends on how fast the amp and the phone react.
 * Defaults are what worked on a ZK-502MT. The logger page can change them; the app reads
 * them at start (same browser storage), so tuned values apply to both.
 */
export interface Timing {
  /** wait after the amp moves to Bluetooth before AUX priority switches back */
  priorityDelayMs: number;
  /** minimum time between two AUX priority switches */
  priorityGapMs: number;
  /** after a priority switch, check again this much later (a phone often pulls the amp back) */
  priorityRecheckMs: number;
  /** AUX priority gives up for a minute after this many switches */
  priorityMaxPerMinute: number;
  /** after "disconnect the phone", how long to wait for the amp to move to AUX by itself */
  dropWaitMs: number;
  /** delay between gain steps */
  gainStepMs: number;
  /** how often to re-read "phone connected" (the amp doesn't push it) */
  pollMs: number;
}

export const DEFAULT_TIMING: Timing = {
  priorityDelayMs: 0,
  priorityGapMs: 2000,
  priorityRecheckMs: 2500,
  priorityMaxPerMinute: 6,
  dropWaitMs: 2500,
  gainStepMs: 120,
  pollMs: 5000,
};

/** min/max per field, so a typo can't make the app hammer the amp */
export const TIMING_LIMITS: Record<keyof Timing, [number, number]> = {
  priorityDelayMs: [0, 60_000],
  priorityGapMs: [500, 60_000],
  priorityRecheckMs: [500, 60_000],
  priorityMaxPerMinute: [1, 30],
  dropWaitMs: [500, 10_000],
  gainStepMs: [50, 2000],
  pollMs: [1000, 60_000],
};

const KEY = 'wuzhi.timing.v1';

export function clampTiming(t: Partial<Record<keyof Timing, unknown>>): Timing {
  const out = { ...DEFAULT_TIMING };
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) {
    const v = Number(t[k]);
    if (t[k] !== undefined && Number.isFinite(v)) out[k] = Math.round(Math.min(TIMING_LIMITS[k][1], Math.max(TIMING_LIMITS[k][0], v)));
  }
  return out;
}

export function loadTiming(): Timing {
  try {
    return clampTiming(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Timing>);
  } catch {
    return { ...DEFAULT_TIMING };
  }
}

export function saveTiming(t: Timing): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* storage unavailable */
  }
}
