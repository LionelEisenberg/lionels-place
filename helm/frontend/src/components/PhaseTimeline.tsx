import { useEffect, useMemo, useRef } from 'react';
import type { PhaseResponse, WeightProjectionResponse, PhaseType } from '../api';

interface Props {
  phases: PhaseResponse[];
  currentPhaseId: number | null;
  todayISO: string;
  projections: Record<number, WeightProjectionResponse>;
  onPhaseClick?: (id: number) => void;
}

const MS_PER_DAY = 86_400_000;
const DAY_WIDTH = 4;          // px per day at default zoom
const NOW_LABEL_PAD = 28;
const HORIZON_PAD_DAYS = 14;  // empty future runway after the last phase ends
// Horizontal gutter on either side of the timeline content so the leftmost
// segment doesn't touch the card edge and the rightmost year label has room.
const PAD_X = 32;

const PHASE_COLOR: Record<PhaseType, string> = {
  cut: '#f87171',
  maintenance: '#fbbf24',
  bulk: '#34d399',
};

const PHASE_LABEL: Record<PhaseType, string> = {
  cut: 'CUT',
  maintenance: 'MAINTENANCE',
  bulk: 'BULK',
};

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / MS_PER_DAY);
}

function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthTicks(startISO: string, endISO: string): string[] {
  // First of each month between start and end, inclusive
  const out: string[] = [];
  const start = toDate(startISO);
  const end = toDate(endISO);
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

function monthLabel(iso: string): string {
  const d = toDate(iso);
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
}

function yearLabel(iso: string): string {
  return iso.slice(0, 4);
}

function fmtShortDate(iso: string): string {
  const d = toDate(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function PhaseTimeline({
  phases, currentPhaseId, todayISO, projections, onPhaseClick,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Compute timeline bounds
  const {
    rangeStart, totalDays, segments, refeedMarks, monthAxis,
  } = useMemo(() => {
    if (phases.length === 0) {
      return {
        rangeStart: todayISO,
        totalDays: 1,
        segments: [] as Array<{
          phase: PhaseResponse; xPct: number; widthPct: number;
          kind: 'past' | 'current' | 'projection';
        }>,
        refeedMarks: [] as Array<{
          phase: PhaseResponse; refeedId: number;
          xPct: number; widthPct: number; label: string;
        }>,
        monthAxis: [] as Array<{ iso: string; xPct: number }>,
      };
    }
    const sorted = [...phases].sort((a, b) => a.start_date.localeCompare(b.start_date));
    const firstStart = sorted[0].start_date;

    // For each phase, figure out its "render end" = end_date if set, else today.
    // Also figure out projection target dates for the current phase.
    let renderEndMax = todayISO;
    for (const p of sorted) {
      const e = p.end_date ?? todayISO;
      if (e > renderEndMax) renderEndMax = e;
    }
    // Include projected end dates for any phase with a known projected_date.
    for (const p of sorted) {
      const proj = projections[p.id];
      if (proj?.projected_date && proj.projected_date > renderEndMax) {
        renderEndMax = proj.projected_date;
      }
    }
    const rangeStart = firstStart < todayISO ? firstStart : todayISO;
    const rangeEnd = addDays(renderEndMax, HORIZON_PAD_DAYS);
    const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd) + 1);

    interface Seg {
      phase: PhaseResponse;
      xPct: number;          // 0-1 left
      widthPct: number;
      kind: 'past' | 'current' | 'projection';
    }
    const segments: Seg[] = [];
    const refeedMarks: Array<{
      phase: PhaseResponse;
      refeedId: number;
      xPct: number;
      widthPct: number;
      label: string;
    }> = [];

    for (const p of sorted) {
      const end = p.end_date ?? todayISO;
      const isCurrent = p.id === currentPhaseId;
      const offset = daysBetween(rangeStart, p.start_date);
      // Past phases use an inclusive day count (end_date is the last day, so
      // the segment fills through the end of that day's column → +1).
      // Ongoing phases end "right now", which we anchor to the START of today's
      // column — matching the NOW line position so the segment doesn't visually
      // extend past it. Math.max(1, ...) guarantees same-day phases render.
      const span = p.end_date
        ? Math.max(1, daysBetween(p.start_date, end) + 1)
        : Math.max(1, daysBetween(p.start_date, end));
      segments.push({
        phase: p,
        xPct: offset / totalDays,
        widthPct: span / totalDays,
        kind: isCurrent ? 'current' : 'past',
      });

      // Projection: for current phase with a projected_date past `end`, add faded extension.
      // Starts AT today (matches where the solid segment ends), runs to projected_date inclusive.
      if (isCurrent && !p.end_date) {
        const proj = projections[p.id];
        if (proj?.projected_date && proj.projected_date > end) {
          const projOffset = daysBetween(rangeStart, end);
          const projSpan = Math.max(
            1, daysBetween(end, proj.projected_date) + 1,
          );
          segments.push({
            phase: p,
            xPct: projOffset / totalDays,
            widthPct: projSpan / totalDays,
            kind: 'projection',
          });
        }
      }

      // Refeeds — only on cut phases
      if (p.phase_type === 'cut') {
        for (const rf of p.refeeds) {
          const rfStart = rf.start_date < p.start_date ? p.start_date : rf.start_date;
          const rfEnd = rf.end_date > end ? end : rf.end_date;
          if (rfStart > rfEnd) continue;
          const rOffset = daysBetween(rangeStart, rfStart);
          const rSpan = Math.max(1, daysBetween(rfStart, rfEnd) + 1);
          refeedMarks.push({
            phase: p,
            refeedId: rf.id,
            xPct: rOffset / totalDays,
            widthPct: rSpan / totalDays,
            label: `Refeed · ${fmtShortDate(rf.start_date)} – ${fmtShortDate(rf.end_date)}`,
          });
        }
      }
    }

    const monthAxis = monthTicks(rangeStart, rangeEnd).map(iso => ({
      iso,
      xPct: daysBetween(rangeStart, iso) / totalDays,
    }));

    return { rangeStart, totalDays, segments, refeedMarks, monthAxis };
  }, [phases, currentPhaseId, todayISO, projections]);

  // Inner content width (segment band) — pad both sides for gutter
  const contentWidthPx = Math.max(640, totalDays * DAY_WIDTH);
  const widthPx = contentWidthPx + PAD_X * 2;
  const nowOffsetPx =
    PAD_X + Math.max(0, daysBetween(rangeStart, todayISO)) * (contentWidthPx / totalDays);

  // On mount / when widthPx changes, scroll so NOW is ~ 75% across the viewport.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = Math.max(0, nowOffsetPx - el.clientWidth * 0.75);
    el.scrollLeft = target;
  }, [widthPx, nowOffsetPx]);

  if (phases.length === 0) {
    return (
      <div className="ph2-timeline ph2-timeline-empty">
        <div className="ph2-timeline-grid" aria-hidden="true" />
        <div className="ph2-timeline-empty-label">No timeline yet</div>
      </div>
    );
  }

  return (
    <div className="ph2-timeline" ref={scrollerRef}>
      <div className="ph2-timeline-inner" style={{ width: `${widthPx}px` }}>
        {/* graph-paper grid */}
        <div className="ph2-timeline-grid" aria-hidden="true" />

        {/* axis month labels */}
        <div className="ph2-timeline-axis" aria-hidden="true">
          {monthAxis.map((m, i) => {
            const x = PAD_X + m.xPct * contentWidthPx;
            const showYear = i === 0 || monthLabel(m.iso) === 'JAN';
            return (
              <div key={m.iso} className="ph2-timeline-tick" style={{ left: `${x}px` }}>
                <span className="ph2-timeline-tick-line" />
                <span className="ph2-timeline-tick-label">
                  {monthLabel(m.iso)}
                  {showYear && <span className="ph2-timeline-tick-year"> {yearLabel(m.iso)}</span>}
                </span>
              </div>
            );
          })}
        </div>

        {/* phase segments band */}
        <div className="ph2-timeline-band">
          {segments.map((s, i) => {
            const color = PHASE_COLOR[s.phase.phase_type];
            const left = PAD_X + s.xPct * contentWidthPx;
            const width = Math.max(2, s.widthPct * contentWidthPx);
            const cls = [
              'ph2-seg',
              `ph2-seg-${s.phase.phase_type}`,
              s.kind === 'projection' ? 'ph2-seg-projection' : '',
              s.kind === 'current' ? 'ph2-seg-current' : '',
            ].filter(Boolean).join(' ');
            return (
              <button
                key={`${s.phase.id}-${s.kind}-${i}`}
                type="button"
                className={cls}
                style={{
                  left: `${left}px`,
                  width: `${width}px`,
                  ['--seg-color' as any]: color,
                }}
                onClick={() => s.kind !== 'projection' && onPhaseClick?.(s.phase.id)}
                title={`${PHASE_LABEL[s.phase.phase_type]} · ${fmtShortDate(s.phase.start_date)} – ${
                  s.phase.end_date ? fmtShortDate(s.phase.end_date) : 'ongoing'
                }${s.kind === 'projection' ? ' · projected' : ''}`}
              >
                {width >= 80 && s.kind !== 'projection' && (
                  <span className="ph2-seg-label">
                    {PHASE_LABEL[s.phase.phase_type]}
                  </span>
                )}
              </button>
            );
          })}

          {/* NOW marker */}
          <div className="ph2-now" style={{ left: `${nowOffsetPx}px` }}>
            <div className="ph2-now-line" />
            <div className="ph2-now-label" style={{ top: `${NOW_LABEL_PAD - 28}px` }}>
              NOW
            </div>
            <div className="ph2-now-date">{fmtShortDate(todayISO)}</div>
          </div>
        </div>

        {/* Refeed overlay layer — sits ABOVE phase segments so hover state on
            segments can never hide the refeed marks. */}
        <div className="ph2-timeline-refeed-overlay" aria-hidden="false">
          {refeedMarks.map(rm => {
            const left = PAD_X + rm.xPct * contentWidthPx;
            const width = Math.max(3, rm.widthPct * contentWidthPx);
            return (
              <div
                key={rm.refeedId}
                className="ph2-seg-refeed"
                style={{ left: `${left}px`, width: `${width}px` }}
                title={rm.label}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
