/**
 * Cumulative-deficit chart math for the Helm dashboard.
 *
 * Produces the three series shown on the "Cumulative Deficit" chart plus the
 * headline stats:
 *   - cumulative  (Tracked):       running sum of net_deficit over logged days
 *   - scaleCumulative (Scale trend): weight-regression loss x 3500 cal/lb
 *   - scaleActual (Scale actual):  raw weight change x 3500 cal/lb
 *
 * Dates are parsed as UTC midnight (`new Date('YYYY-MM-DD')`) so day deltas are
 * exact integers regardless of the viewer's timezone / DST.
 */

const CAL_PER_LB = 3500;
const DAY_MS = 86_400_000;

export interface DeficitInputDay {
  date: string;            // YYYY-MM-DD
  calories_in: number;
  net_deficit: number;
  weight_lbs?: number | null;
}

export interface DeficitPoint {
  date: string;            // MM-DD (x-axis label)
  fullDate: string;        // YYYY-MM-DD
  cumulative: number;
  scaleCumulative: number | null;
  scaleActual: number | null;
}

export interface DeficitStats {
  trackedDeficit: number;
  scaleDeficit: number | null;
  scaleActualDeficit: number | null;
  accuracy: number | null;   // percent, trackedDeficit / scaleDeficit
}

export interface DeficitChart {
  data: DeficitPoint[];
  stats: DeficitStats;
}

/** Whole-day index for an ISO date (UTC midnight), used for regression x-values. */
function dayIndex(iso: string): number {
  return new Date(iso).getTime() / DAY_MS;
}

interface WeightReg {
  slope: number;       // lb per day
  intercept: number;   // trend weight at the first weigh-in (day 0)
  t0Day: number;       // dayIndex of the first weigh-in
  lastX: number;       // day offset of the last weigh-in from the first
}

/** OLS regression of weight vs. days-since-first-weigh-in. Null with < 2 weigh-ins. */
function weightRegression(weightDays: DeficitInputDay[]): WeightReg | null {
  if (weightDays.length < 2) return null;
  const t0Day = dayIndex(weightDays[0].date);
  const pts = weightDays.map(d => ({ x: dayIndex(d.date) - t0Day, y: d.weight_lbs as number }));
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sx2 = pts.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sx2 - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = denom !== 0 ? (sy - slope * sx) / n : sy / n;
  return { slope, intercept, t0Day, lastX: pts[pts.length - 1].x };
}

/**
 * Build the cumulative-deficit series + stats from a chronologically-sorted
 * array of daily summaries.
 */
export function buildDeficitChart(days: DeficitInputDay[]): DeficitChart {
  const weightDays = days.filter(d => d.weight_lbs && d.weight_lbs > 0);
  const reg = weightRegression(weightDays);
  const firstWeight = weightDays.length > 0 ? (weightDays[0].weight_lbs as number) : null;

  // Lookup of actual weigh-ins by date for the raw "scale (actual)" line.
  const weightByDate: Record<string, number> = {};
  for (const wd of weightDays) {
    if (wd.weight_lbs) weightByDate[wd.date] = wd.weight_lbs;
  }

  let cumDef = 0;
  let lastKnownWeight = firstWeight;
  const data: DeficitPoint[] = days
    // Only days where food was actually logged. A day with body metrics but no
    // food (calories_in === 0) would otherwise carry net_deficit ≈ full TDEE and
    // inject a phantom one-day deficit into the running total.
    .filter(d => d.calories_in > 0)
    .map(d => {
      cumDef += d.net_deficit;

      let scaleCumulative: number | null = null;
      if (reg) {
        const dayDelta = dayIndex(d.date) - reg.t0Day;
        if (dayDelta >= 0) {
          const trendWeightAtDay = reg.intercept + reg.slope * dayDelta;
          const weightLost = reg.intercept - trendWeightAtDay;
          scaleCumulative = Math.round(weightLost * CAL_PER_LB);
        }
      }

      let scaleActual: number | null = null;
      if (firstWeight != null) {
        if (weightByDate[d.date] != null) lastKnownWeight = weightByDate[d.date];
        if (lastKnownWeight != null) {
          scaleActual = Math.round((firstWeight - lastKnownWeight) * CAL_PER_LB);
        }
      }

      return {
        date: d.date.slice(5),
        fullDate: d.date,
        cumulative: Math.round(cumDef),
        scaleCumulative,
        scaleActual,
      };
    });

  const trackedDeficit = data.length > 0 ? data[data.length - 1].cumulative : 0;
  let scaleDeficit: number | null = null;
  let accuracy: number | null = null;
  if (reg) {
    const firstTrend = reg.intercept;
    const lastTrend = reg.intercept + reg.slope * reg.lastX;
    scaleDeficit = Math.round((firstTrend - lastTrend) * CAL_PER_LB);
    const totalDays = reg.lastX;
    if (totalDays >= 30 && scaleDeficit > 0 && trackedDeficit > 0) {
      accuracy = Math.round((trackedDeficit / scaleDeficit) * 100);
    }
  }
  const scaleActualDeficit = data.length > 0 ? data[data.length - 1].scaleActual : null;

  return { data, stats: { trackedDeficit, scaleDeficit, scaleActualDeficit, accuracy } };
}
