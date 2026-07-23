import type { PhaseResponse, RefeedResponse, PhaseType } from '../api';

function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function inclusiveDayDiff(startISO: string, endISO: string): number {
  const ms = isoToDate(endISO).getTime() - isoToDate(startISO).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

const TYPE_LABEL: Record<PhaseType, string> = {
  cut: 'Cut',
  maintenance: 'Maintenance',
  bulk: 'Bulk',
};

export function formatPhaseLabel(phase: PhaseResponse, todayISO: string): string {
  const day = inclusiveDayDiff(phase.start_date, todayISO);
  const base = `${TYPE_LABEL[phase.phase_type]} · Day ${day}`;
  if (phase.end_date) {
    const remaining = inclusiveDayDiff(todayISO, phase.end_date) - 1;   // exclusive
    if (remaining > 0) return `${base} · ends in ${remaining} days`;
  }
  return base;
}

export function formatRefeedLabel(refeed: RefeedResponse, todayISO: string): string {
  const day = inclusiveDayDiff(refeed.start_date, todayISO);
  const total = inclusiveDayDiff(refeed.start_date, refeed.end_date);
  return `Refeed Day ${day} of ${total}`;
}

export interface PrefilledMacros {
  target_calories: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  target_fiber_g: number;
}

export function prefillMacrosForPhaseType(
  type: PhaseType,
  currentWeightLbs: number,
  tdee: number,
): PrefilledMacros {
  const proteinPerLb = type === 'cut' ? 1.0 : 0.9;
  const fatPerLb = type === 'bulk' ? 0.5 : 0.4;
  const calMultiplier = type === 'cut' ? 0.80 : type === 'bulk' ? 1.10 : 1.00;
  const fiber = type === 'bulk' ? 35 : 30;

  const calories = Math.round(tdee * calMultiplier);
  const protein = Math.round(currentWeightLbs * proteinPerLb);
  const fat = Math.round(currentWeightLbs * fatPerLb);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));

  return {
    target_calories: calories,
    target_protein_g: protein,
    target_carbs_g: carbs,
    target_fat_g: fat,
    target_fiber_g: fiber,
  };
}

export function dayOfPhase(phase: PhaseResponse, dateISO: string): number {
  return inclusiveDayDiff(phase.start_date, dateISO);
}

export function phaseForDate(
  phases: PhaseResponse[], dateISO: string,
): PhaseResponse | null {
  for (const p of phases) {
    if (p.start_date <= dateISO && (p.end_date === null || p.end_date >= dateISO)) {
      return p;
    }
  }
  return null;
}

export interface DailyTargets {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  in_refeed: boolean;
  phase_type: PhaseType | null;
}

export function targetsForDate(
  phases: PhaseResponse[],
  dateISO: string,
  envDefaults: DailyTargets,
): DailyTargets {
  const phase = phaseForDate(phases, dateISO);
  if (!phase) return envDefaults;

  if (phase.phase_type === 'cut') {
    const refeed = phase.refeeds.find(
      r => r.start_date <= dateISO && r.end_date >= dateISO,
    );
    if (refeed) {
      return {
        calories: refeed.target_calories,
        protein_g: refeed.target_protein_g,
        carbs_g: refeed.target_carbs_g,
        fat_g: refeed.target_fat_g,
        fiber_g: refeed.target_fiber_g,
        in_refeed: true,
        phase_type: 'cut',
      };
    }
  }
  return {
    calories: phase.target_calories,
    protein_g: phase.target_protein_g,
    carbs_g: phase.target_carbs_g,
    fat_g: phase.target_fat_g,
    fiber_g: phase.target_fiber_g,
    in_refeed: false,
    phase_type: phase.phase_type,
  };
}

/** Severity level for a macro/calorie value vs its target. */
export type MacroLevel = 'green' | 'amber' | 'red' | 'extreme';

/** Semantic kind of target.
 *  - 'cap': calories/carbs/fat — under target is good, over is bad.
 *  - 'minimum': protein/fiber — at-or-over target is good, under is bad. */
export type MacroKind = 'cap' | 'minimum';

export interface MacroLevelOpts {
  kind: MacroKind;
  /** For 'cap' only: absolute amount over target that escalates 'red' → 'extreme'.
   *  e.g. calories use 1500 (an absurd overshoot). Omit if no extreme tier. */
  extremeOverAbsolute?: number;
}

/** Returns the color level for an actual value vs its target.
 *
 *  cap rules:
 *    actual ≤ target                              → green
 *    target < actual ≤ target × 1.10              → amber
 *    actual > target × 1.10                       → red
 *    extremeOverAbsolute set AND
 *      actual ≥ target + extremeOverAbsolute      → extreme  (overrides red)
 *
 *  minimum rules (no extreme tier):
 *    actual ≥ target                              → green
 *    target × 0.90 ≤ actual < target              → amber
 *    actual < target × 0.90                       → red
 *
 *  Edge cases:
 *    target ≤ 0 → green (no meaningful target to compare against). */
export function macroLevel(
  actual: number,
  target: number,
  opts: MacroLevelOpts,
): MacroLevel {
  if (target <= 0) return 'green';
  if (opts.kind === 'cap') {
    if (
      opts.extremeOverAbsolute !== undefined &&
      actual >= target + opts.extremeOverAbsolute
    ) {
      return 'extreme';
    }
    if (actual <= target) return 'green';
    if (actual <= target * 1.10) return 'amber';
    return 'red';
  }
  // minimum
  if (actual >= target) return 'green';
  if (actual >= target * 0.90) return 'amber';
  return 'red';
}

/** End date used for filtering "open-ended" phases (today). */
function effectiveEnd(phase: PhaseResponse, todayISO: string): string {
  return phase.end_date ?? todayISO;
}

/** Returns rows whose `date` lies inside the phase window.
 *  Set `excludeRefeeds` to drop dates inside any of the cut phase's refeed sub-ranges. */
export function rowsForPhase<T extends { date: string }>(
  phase: PhaseResponse,
  rows: T[],
  opts?: { excludeRefeeds?: boolean; todayISO?: string },
): T[] {
  const today = opts?.todayISO ?? new Date().toISOString().slice(0, 10);
  const end = effectiveEnd(phase, today);
  const inPhase = rows.filter(r => r.date >= phase.start_date && r.date <= end);
  if (!opts?.excludeRefeeds || phase.phase_type !== 'cut') return inPhase;
  return inPhase.filter(r =>
    !phase.refeeds.some(rf => r.date >= rf.start_date && r.date <= rf.end_date),
  );
}

export interface PhaseRegression {
  phase: PhaseResponse;
  slope: number;            // units per day
  intercept: number;        // value at phase.start_date (day 0)
  pointCount: number;       // sample size
}

/** OLS linear regression per phase, anchored to phase.start_date as day 0.
 *  Skips phases with fewer than 4 valid data points. */
export function regressionPerPhase(
  phases: PhaseResponse[],
  rows: Array<{ date: string; value: number | null | undefined }>,
  opts?: { todayISO?: string },
): PhaseRegression[] {
  const today = opts?.todayISO ?? new Date().toISOString().slice(0, 10);
  const out: PhaseRegression[] = [];
  for (const p of phases) {
    const end = effectiveEnd(p, today);
    const t0 = isoToDate(p.start_date).getTime();
    const pts: Array<{ x: number; y: number }> = [];
    for (const r of rows) {
      if (r.value == null) continue;
      if (r.date < p.start_date || r.date > end) continue;
      const x = (isoToDate(r.date).getTime() - t0) / 86_400_000;
      pts.push({ x, y: r.value });
    }
    if (pts.length < 4) continue;
    const n = pts.length;
    const sx = pts.reduce((a, b) => a + b.x, 0);
    const sy = pts.reduce((a, b) => a + b.y, 0);
    const sxy = pts.reduce((a, b) => a + b.x * b.y, 0);
    const sx2 = pts.reduce((a, b) => a + b.x * b.x, 0);
    const denom = n * sx2 - sx * sx;
    if (denom === 0) continue;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    out.push({ phase: p, slope, intercept, pointCount: n });
  }
  return out;
}
