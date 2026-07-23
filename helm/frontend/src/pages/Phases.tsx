import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PhaseResponse, RefeedResponse, PhaseType,
  WeightProjectionResponse, CurrentPhaseResponse,
} from '../api';
import {
  listPhases, getCurrentPhase, createPhase, updatePhase, deletePhase,
  createRefeed, updateRefeed, deleteRefeed,
  getWeightProjection,
  getRunningTotals, getTDEEInfo,
} from '../api';
import { PhaseFormModal } from '../components/PhaseFormModal';
import { RefeedFormModal } from '../components/RefeedFormModal';
import { PhaseTimeline } from '../components/PhaseTimeline';
import { formatRefeedLabel, dayOfPhase } from '../utils/phase-helpers';
import { todayISO } from '../dates';

const TODAY = todayISO();

const PHASE_LABEL: Record<PhaseType, string> = {
  cut: 'CUT',
  maintenance: 'MAINTENANCE',
  bulk: 'BULK',
};

// Full readable name for the marquee mark
const PHASE_TITLE: Record<PhaseType, string> = {
  cut: 'Cut',
  maintenance: 'Maintenance',
  bulk: 'Bulk',
};

const PHASE_MARK: Record<PhaseType, string> = {
  cut: 'C',
  maintenance: 'M',
  bulk: 'B',
};

// Macro key → display config matching Dashboard brand colors
type MacroKey = 'cal' | 'p' | 'c' | 'f' | 'fib';

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

function fmtLongDate(iso: string): string {
  return toDate(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function fmtShortDate(iso: string): string {
  return toDate(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function phaseDurationDays(p: PhaseResponse): number {
  const end = p.end_date ?? TODAY;
  return Math.max(1, daysBetween(p.start_date, end) + 1);
}

interface RefeedDayProgress {
  day: number;
  total: number;
  active: boolean;
}

function refeedProgress(r: RefeedResponse): RefeedDayProgress {
  const total = Math.max(1, daysBetween(r.start_date, r.end_date) + 1);
  const active = r.start_date <= TODAY && r.end_date >= TODAY;
  const day = active ? Math.max(1, daysBetween(r.start_date, TODAY) + 1) : 0;
  return { day, total, active };
}

export default function Phases() {
  const [phases, setPhases] = useState<PhaseResponse[]>([]);
  const [current, setCurrent] = useState<CurrentPhaseResponse | null>(null);
  const [showPhaseModal, setShowPhaseModal] = useState(false);
  const [editingPhase, setEditingPhase] = useState<PhaseResponse | null>(null);
  const [refeedModalParent, setRefeedModalParent] = useState<PhaseResponse | null>(null);
  const [editingRefeed, setEditingRefeed] = useState<RefeedResponse | null>(null);
  const [expandedPast, setExpandedPast] = useState<Set<number>>(new Set());
  const [projections, setProjections] = useState<Record<number, WeightProjectionResponse>>({});
  const [currentWeight, setCurrentWeight] = useState<number | null>(null);
  const [tdee, setTdee] = useState<number | null>(null);
  const [pulseRefeedId, setPulseRefeedId] = useState<number | null>(null);

  const historyRef = useRef<HTMLDivElement | null>(null);
  const currentCardRef = useRef<HTMLDivElement | null>(null);
  const pastRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  async function load() {
    const [p, c] = await Promise.all([listPhases(), getCurrentPhase()]);
    setPhases(p);
    setCurrent(c);
    const projMap: Record<number, WeightProjectionResponse> = {};
    await Promise.all(
      p.filter(ph => ph.target_weight_lbs != null).map(async ph => {
        try { projMap[ph.id] = await getWeightProjection(ph.id); }
        catch { /* ignore — projection is best-effort */ }
      }),
    );
    setProjections(projMap);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    getRunningTotals().then(t => setCurrentWeight(t.weight_lbs ?? null));
    getTDEEInfo().then(info => setTdee(info.tdee ?? null));
  }, []);

  const currentPhase = current?.phase ?? null;

  const sortedPhases = useMemo(
    () => [...phases].sort((a, b) => b.start_date.localeCompare(a.start_date)),
    [phases],
  );
  const pastPhases = sortedPhases.filter(p => p.id !== currentPhase?.id);

  async function handleCreatePhase(data: any) {
    await createPhase(data);
    setShowPhaseModal(false);
    await load();
  }
  async function handleUpdatePhase(data: any) {
    if (!editingPhase) return;
    await updatePhase(editingPhase.id, data);
    setEditingPhase(null);
    await load();
  }
  async function handleDeletePhase(id: number) {
    if (!confirm('Delete this phase and all its refeeds?')) return;
    await deletePhase(id);
    await load();
  }
  async function handleEndPhase(p: PhaseResponse) {
    if (!confirm(`End ${p.phase_type} today?`)) return;
    await updatePhase(p.id, { end_date: TODAY });
    await load();
  }
  async function handleCreateRefeed(data: any) {
    if (!refeedModalParent) return;
    const created = await createRefeed(refeedModalParent.id, data);
    setRefeedModalParent(null);
    await load();
    if (created?.id != null) {
      setPulseRefeedId(created.id);
      window.setTimeout(() => setPulseRefeedId(null), 700);
    }
  }
  async function handleUpdateRefeed(data: any) {
    if (!editingRefeed) return;
    await updateRefeed(editingRefeed.id, data);
    setEditingRefeed(null);
    await load();
  }
  async function handleDeleteRefeed(id: number) {
    if (!confirm('Delete this refeed?')) return;
    await deleteRefeed(id);
    await load();
  }
  async function handleEndRefeedNow(r: RefeedResponse) {
    await updateRefeed(r.id, { end_date: TODAY });
    await load();
  }

  function togglePastExpand(id: number) {
    setExpandedPast(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleTimelinePhaseClick(id: number) {
    if (id === currentPhase?.id) {
      currentCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      currentCardRef.current?.classList.add('ph2-pulse');
      window.setTimeout(() => {
        currentCardRef.current?.classList.remove('ph2-pulse');
      }, 1200);
      return;
    }
    const row = pastRowRefs.current.get(id);
    if (row) {
      // Auto-expand if not already
      if (!expandedPast.has(id)) togglePastExpand(id);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('ph2-pulse');
      window.setTimeout(() => {
        row.classList.remove('ph2-pulse');
      }, 1200);
    }
  }

  return (
    <div className="ph2-page">
      <header className="ph2-header">
        <div className="ph2-header-titles">
          <h1 className="ph2-title">PHASES</h1>
          <p className="ph2-subtitle">your nutrition timeline</p>
        </div>
        <button className="ph2-new-btn" onClick={() => setShowPhaseModal(true)}>
          <span aria-hidden="true">+</span> New Phase
        </button>
      </header>

      {/* TIMELINE STRIP */}
      <section className="ph2-section ph2-stagger-1">
        <PhaseTimeline
          phases={phases}
          currentPhaseId={currentPhase?.id ?? null}
          todayISO={TODAY}
          projections={projections}
          onPhaseClick={handleTimelinePhaseClick}
        />
        <div className="ph2-legend" aria-hidden="true">
          <span className="ph2-legend-item"><span className="ph2-legend-dot ph2-legend-dot-cut" /> Cut</span>
          <span className="ph2-legend-item"><span className="ph2-legend-dot ph2-legend-dot-maintenance" /> Maintenance</span>
          <span className="ph2-legend-item"><span className="ph2-legend-dot ph2-legend-dot-bulk" /> Bulk</span>
          <span className="ph2-legend-item"><span className="ph2-legend-dot ph2-legend-dot-refeed" /> Refeed</span>
          <span className="ph2-legend-item"><span className="ph2-legend-dot ph2-legend-dot-projection" /> Projected</span>
        </div>
      </section>

      {/* CURRENT PHASE DETAIL */}
      {currentPhase ? (
        <section
          className="ph2-section ph2-stagger-2"
          ref={currentCardRef}
        >
          <CurrentPhaseCard
            phase={currentPhase}
            projection={projections[currentPhase.id]}
            currentWeight={currentWeight}
            pulseRefeedId={pulseRefeedId}
            onEdit={() => setEditingPhase(currentPhase)}
            onEndPhase={() => handleEndPhase(currentPhase)}
            onAddRefeed={() => setRefeedModalParent(currentPhase)}
            onEditRefeed={(r) => setEditingRefeed(r)}
            onDeleteRefeed={(id) => handleDeleteRefeed(id)}
            onEndRefeedNow={(r) => handleEndRefeedNow(r)}
          />
        </section>
      ) : phases.length > 0 ? (
        <section className="ph2-section ph2-stagger-2">
          <div className="ph2-banner">
            <div className="ph2-banner-text">
              <span className="ph2-banner-eyebrow">NO ACTIVE PHASE</span>
              <span>Calorie targets fall back to defaults.</span>
            </div>
            <button className="ph2-banner-btn" onClick={() => setShowPhaseModal(true)}>
              Start a new phase
            </button>
          </div>
        </section>
      ) : null}

      {/* HISTORY */}
      {pastPhases.length > 0 && (
        <section className="ph2-section ph2-stagger-3" ref={historyRef}>
          <div className="ph2-section-head">
            <h2 className="ph2-section-title">HISTORY</h2>
            <span className="ph2-section-rule" />
            <span className="ph2-section-count">{pastPhases.length}</span>
          </div>
          <ol className="ph2-history-list">
            {pastPhases.map(p => (
              <PastPhaseRow
                key={p.id}
                phase={p}
                expanded={expandedPast.has(p.id)}
                onToggle={() => togglePastExpand(p.id)}
                onEdit={() => setEditingPhase(p)}
                onDelete={() => handleDeletePhase(p.id)}
                onAddRefeed={() => setRefeedModalParent(p)}
                onEditRefeed={(r) => setEditingRefeed(r)}
                onDeleteRefeed={(id) => handleDeleteRefeed(id)}
                onEndRefeedNow={(r) => handleEndRefeedNow(r)}
                pulseRefeedId={pulseRefeedId}
                registerRow={(el) => {
                  if (el) pastRowRefs.current.set(p.id, el);
                  else pastRowRefs.current.delete(p.id);
                }}
              />
            ))}
          </ol>
        </section>
      )}

      {/* EMPTY STATE */}
      {phases.length === 0 && (
        <section className="ph2-section ph2-stagger-2">
          <div className="ph2-empty">
            <div className="ph2-empty-grid" aria-hidden="true" />
            <div className="ph2-empty-body">
              <h2 className="ph2-empty-title">NO PHASES YET</h2>
              <p className="ph2-empty-copy">
                Phases let Helm track your cuts, maintenance windows, and bulks
                with the right calorie target for each. Start your first phase
                to lay down the spine of your nutrition timeline.
              </p>
              <button className="ph2-empty-btn" onClick={() => setShowPhaseModal(true)}>
                <span aria-hidden="true">+</span> Start Your First Phase
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Modals — unchanged */}
      {showPhaseModal && (
        <PhaseFormModal
          currentOpenPhase={currentPhase}
          currentWeightLbs={currentWeight}
          tdee={tdee}
          onCancel={() => setShowPhaseModal(false)}
          onSubmit={handleCreatePhase}
        />
      )}
      {editingPhase && (
        <PhaseFormModal
          initial={editingPhase}
          currentOpenPhase={currentPhase}
          currentWeightLbs={currentWeight}
          tdee={tdee}
          onCancel={() => setEditingPhase(null)}
          onSubmit={handleUpdatePhase}
        />
      )}
      {refeedModalParent && (
        <RefeedFormModal
          parentPhase={refeedModalParent}
          onCancel={() => setRefeedModalParent(null)}
          onSubmit={handleCreateRefeed}
        />
      )}
      {editingRefeed && (() => {
        const parent = phases.find(p => p.id === editingRefeed.phase_id);
        if (!parent) return null;
        return (
          <RefeedFormModal
            parentPhase={parent}
            initial={editingRefeed}
            onCancel={() => setEditingRefeed(null)}
            onSubmit={handleUpdateRefeed}
          />
        );
      })()}
    </div>
  );
}

// ============================================================
// CurrentPhaseCard — the big anchor card for the active phase
// ============================================================
interface CurrentPhaseCardProps {
  phase: PhaseResponse;
  projection?: WeightProjectionResponse;
  currentWeight: number | null;
  pulseRefeedId: number | null;
  onEdit: () => void;
  onEndPhase: () => void;
  onAddRefeed: () => void;
  onEditRefeed: (r: RefeedResponse) => void;
  onDeleteRefeed: (id: number) => void;
  onEndRefeedNow: (r: RefeedResponse) => void;
}

function CurrentPhaseCard({
  phase, projection, currentWeight, pulseRefeedId,
  onEdit, onEndPhase, onAddRefeed,
  onEditRefeed, onDeleteRefeed, onEndRefeedNow,
}: CurrentPhaseCardProps) {
  const day = dayOfPhase(phase, TODAY);
  const totalDays = phase.end_date ? phaseDurationDays(phase) : null;
  const progressPct = totalDays ? Math.min(100, (day / totalDays) * 100) : null;
  const phaseColorClass = `ph2-color-${phase.phase_type}`;

  const sortedRefeeds = [...phase.refeeds].sort((a, b) => a.start_date.localeCompare(b.start_date));

  // Weight projection — derived values for the STARTING → NOW → TARGET panel
  const startingValue = projection?.starting_value ?? null;
  const deltaFromStart =
    startingValue != null && currentWeight != null
      ? currentWeight - startingValue
      : null;
  const daysSinceStart = Math.max(0, daysBetween(phase.start_date, TODAY));
  // For cuts, losing weight (delta < 0) is GOOD (green); for bulks, gaining is good.
  const deltaIsGood =
    deltaFromStart == null
      ? null
      : phase.phase_type === 'cut'
        ? deltaFromStart < 0
        : phase.phase_type === 'bulk'
          ? deltaFromStart > 0
          : Math.abs(deltaFromStart) < 1.0;     // maintenance — within ±1 lb is good

  return (
    <div className={`ph2-current-card ${phaseColorClass}`}>
      <div className="ph2-current-glow" aria-hidden="true" />
      <div className="ph2-current-grid">
        {/* LEFT — identity + progress */}
        <div className="ph2-current-identity">
          <div className="ph2-marquee" aria-hidden="true">
            <span className="ph2-marquee-text">{PHASE_TITLE[phase.phase_type]}</span>
          </div>
          <div className="ph2-identity-body">
            <div className="ph2-eyebrow">CURRENT PHASE</div>
            <div className="ph2-current-dates">
              <span className="ph2-mono">{fmtLongDate(phase.start_date)}</span>
              <span className="ph2-dates-arrow" aria-hidden="true">→</span>
              <span className="ph2-mono">
                {phase.end_date ? fmtLongDate(phase.end_date) : 'ongoing'}
              </span>
            </div>

            <div className="ph2-day-progress">
              <div className="ph2-day-numbers">
                <span className="ph2-day-label">DAY</span>
                <span className="ph2-day-big ph2-mono">{day}</span>
                {totalDays ? (
                  <span className="ph2-day-of ph2-mono">/ {totalDays}</span>
                ) : (
                  <span className="ph2-day-of ph2-mono">· ongoing</span>
                )}
              </div>
              {progressPct != null && (
                <div className="ph2-progress-track">
                  <div
                    className="ph2-progress-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — targets + projection */}
        <div className="ph2-current-stats">
          <div className="ph2-eyebrow">TARGETS</div>
          <div className="ph2-target-grid">
            <TargetChip label="CAL" value={phase.target_calories} unit="" macro="cal" />
            <TargetChip label="P"   value={phase.target_protein_g} unit="g" macro="p" />
            <TargetChip label="C"   value={phase.target_carbs_g}   unit="g" macro="c" />
            <TargetChip label="F"   value={phase.target_fat_g}     unit="g" macro="f" />
            <TargetChip label="FIB" value={phase.target_fiber_g}   unit="g" macro="fib" />
          </div>

          {phase.target_weight_lbs != null && (
            <div className="ph2-projection">
              <div className="ph2-eyebrow">WEIGHT</div>
              <div className="ph2-weight-row">
                {startingValue != null && (
                  <>
                    <div className="ph2-weight-cell">
                      <span className="ph2-weight-label">STARTING</span>
                      <span className="ph2-weight-val ph2-mono">
                        {startingValue.toFixed(1)}
                        <span className="ph2-unit"> lb</span>
                      </span>
                    </div>
                    <span className="ph2-weight-arrow" aria-hidden="true">→</span>
                  </>
                )}
                <div className="ph2-weight-cell">
                  <span className="ph2-weight-label">NOW</span>
                  <span className="ph2-weight-val ph2-mono">
                    {currentWeight != null ? currentWeight.toFixed(1) : '—'}
                    <span className="ph2-unit"> lb</span>
                  </span>
                </div>
                <span className="ph2-weight-arrow" aria-hidden="true">→</span>
                <div className="ph2-weight-cell">
                  <span className="ph2-weight-label">TARGET</span>
                  <span className="ph2-weight-val ph2-mono">
                    {phase.target_weight_lbs.toFixed(1)}
                    <span className="ph2-unit"> lb</span>
                  </span>
                </div>
              </div>
              {deltaFromStart != null && (
                <div className="ph2-weight-delta">
                  <span className="ph2-weight-delta-label">Δ from start:</span>
                  <span className={[
                    'ph2-mono',
                    'ph2-weight-delta-val',
                    deltaIsGood ? 'ph2-weight-delta-good' : 'ph2-weight-delta-bad',
                  ].filter(Boolean).join(' ')}>
                    {deltaFromStart >= 0 ? '+' : ''}{deltaFromStart.toFixed(1)} lbs
                  </span>
                  <span className="ph2-weight-delta-meta ph2-mono">
                    (over {daysSinceStart} day{daysSinceStart === 1 ? '' : 's'})
                  </span>
                </div>
              )}
              {projection && (
                <div className="ph2-proj-meta">
                  {projection.projected_date && (
                    <span className="ph2-proj-meta-item">
                      <span className="ph2-proj-meta-label">EST</span>
                      <span className="ph2-mono">{fmtShortDate(projection.projected_date)}</span>
                    </span>
                  )}
                  {projection.pace_per_week != null && (
                    <span className="ph2-proj-meta-item">
                      <span className="ph2-proj-meta-label">PACE</span>
                      <span className="ph2-mono">
                        {projection.pace_per_week >= 0 ? '+' : ''}
                        {projection.pace_per_week.toFixed(2)} lb/wk
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* REFEEDS subsection */}
      <div className="ph2-refeeds">
        <div className="ph2-section-head ph2-refeeds-head">
          <h3 className="ph2-section-title">REFEEDS</h3>
          <span className="ph2-section-rule" />
          {phase.phase_type === 'cut' && (
            <button className="ph2-add-refeed-btn" onClick={onAddRefeed}>
              + Add Refeed
            </button>
          )}
        </div>
        {sortedRefeeds.length === 0 ? (
          <div className="ph2-refeeds-empty">
            {phase.phase_type === 'cut'
              ? 'No refeeds yet — schedule one to break up the cut.'
              : 'Refeeds are only used during cuts.'}
          </div>
        ) : (
          <ul className="ph2-refeed-list">
            {sortedRefeeds.map(r => (
              <li
                key={r.id}
                className={[
                  'ph2-refeed-card',
                  pulseRefeedId === r.id ? 'ph2-refeed-card-new' : '',
                ].filter(Boolean).join(' ')}
              >
                <RefeedCard
                  refeed={r}
                  onEdit={() => onEditRefeed(r)}
                  onDelete={() => onDeleteRefeed(r.id)}
                  onEndNow={() => onEndRefeedNow(r)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="ph2-current-footer">
        <button className="ph2-icon-btn" onClick={onEdit} aria-label="Edit phase">
          <span className="ph2-icon-btn-icon">✎</span>
          <span>Edit</span>
        </button>
        <button className="ph2-end-btn" onClick={onEndPhase}>
          End phase today
        </button>
      </footer>
    </div>
  );
}

interface TargetChipProps {
  label: string;
  value: number;
  unit: string;
  macro?: MacroKey;        // when provided, chip is branded with macro color
}

function TargetChip({ label, value, unit, macro }: TargetChipProps) {
  const chipClass = [
    'ph2-target-chip',
    macro ? `ph2-target-chip-${macro}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={chipClass}>
      <span className="ph2-target-label">{label}</span>
      <span className="ph2-target-value ph2-mono">
        {value.toLocaleString()}
        {unit && <span className="ph2-unit">{unit}</span>}
      </span>
    </div>
  );
}

// ============================================================
// RefeedCard — compact card for an individual refeed
// ============================================================
interface RefeedCardProps {
  refeed: RefeedResponse;
  onEdit: () => void;
  onDelete: () => void;
  onEndNow: () => void;
}

function RefeedCard({ refeed, onEdit, onDelete, onEndNow }: RefeedCardProps) {
  const { day, total, active } = refeedProgress(refeed);
  const pct = active ? Math.min(100, (day / total) * 100) : 0;
  const isPast = refeed.end_date < TODAY;

  return (
    <div className={[
      'ph2-refeed-inner',
      active ? 'ph2-refeed-active' : '',
      isPast ? 'ph2-refeed-past' : '',
    ].filter(Boolean).join(' ')}>
      <div className="ph2-refeed-line-1">
        <span className="ph2-refeed-dot" aria-hidden="true" />
        <span className="ph2-mono ph2-refeed-dates">
          {fmtShortDate(refeed.start_date)} – {fmtShortDate(refeed.end_date)}
        </span>
        {active && (
          <span className="ph2-refeed-pill">{formatRefeedLabel(refeed, TODAY)}</span>
        )}
        <span className="ph2-refeed-spacer" />
        <div className="ph2-refeed-actions">
          {active && (
            <button className="ph2-mini-btn" onClick={onEndNow}>End now</button>
          )}
          <button className="ph2-icon-only" onClick={onEdit} aria-label="Edit refeed">✎</button>
          <button className="ph2-icon-only ph2-icon-only-danger" onClick={onDelete} aria-label="Delete refeed">×</button>
        </div>
      </div>
      <div className="ph2-refeed-line-2">
        <span className="ph2-refeed-macro ph2-mono">{refeed.target_calories.toLocaleString()}<span className="ph2-unit"> cal</span></span>
        <span className="ph2-refeed-sep" aria-hidden="true">·</span>
        <span className="ph2-refeed-macro ph2-mono">{refeed.target_protein_g}<span className="ph2-unit">g P</span></span>
        <span className="ph2-refeed-sep" aria-hidden="true">·</span>
        <span className="ph2-refeed-macro ph2-mono">{refeed.target_carbs_g}<span className="ph2-unit">g C</span></span>
        <span className="ph2-refeed-sep" aria-hidden="true">·</span>
        <span className="ph2-refeed-macro ph2-mono">{refeed.target_fat_g}<span className="ph2-unit">g F</span></span>
      </div>
      {active && (
        <div className="ph2-refeed-track">
          <div className="ph2-refeed-track-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// PastPhaseRow — compact row, expand to reveal targets/refeeds
// ============================================================
interface PastPhaseRowProps {
  phase: PhaseResponse;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddRefeed: () => void;
  onEditRefeed: (r: RefeedResponse) => void;
  onDeleteRefeed: (id: number) => void;
  onEndRefeedNow: (r: RefeedResponse) => void;
  pulseRefeedId: number | null;
  registerRow: (el: HTMLDivElement | null) => void;
}

function PastPhaseRow({
  phase, expanded, onToggle, onEdit, onDelete,
  onAddRefeed, onEditRefeed, onDeleteRefeed, onEndRefeedNow,
  pulseRefeedId, registerRow,
}: PastPhaseRowProps) {
  const duration = phaseDurationDays(phase);
  const phaseColorClass = `ph2-color-${phase.phase_type}`;
  const sortedRefeeds = [...phase.refeeds].sort((a, b) => a.start_date.localeCompare(b.start_date));

  return (
    <li className={`ph2-history-item ${phaseColorClass}`}>
      <div ref={registerRow} className="ph2-history-row">
        <button
          type="button"
          className="ph2-history-main"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="ph2-history-block" aria-hidden="true" />
          <span className="ph2-history-mark" aria-hidden="true">{PHASE_MARK[phase.phase_type]}</span>
          <span className="ph2-history-body">
            <span className="ph2-history-line-1">
              <span className="ph2-history-name">{PHASE_LABEL[phase.phase_type]}</span>
              <span className="ph2-history-duration ph2-mono">{duration}d</span>
            </span>
            <span className="ph2-history-line-2">
              <span className="ph2-mono">{fmtShortDate(phase.start_date)}</span>
              <span className="ph2-history-arrow" aria-hidden="true">→</span>
              <span className="ph2-mono">
                {phase.end_date ? fmtShortDate(phase.end_date) : 'ongoing'}
              </span>
              <span className="ph2-history-dot" aria-hidden="true">·</span>
              <span className="ph2-mono">{phase.target_calories.toLocaleString()} cal</span>
              {phase.target_weight_lbs != null && (
                <>
                  <span className="ph2-history-dot" aria-hidden="true">·</span>
                  <span className="ph2-mono">{phase.target_weight_lbs.toFixed(1)} lb target</span>
                </>
              )}
            </span>
          </span>
          <span className={`ph2-history-chev ${expanded ? 'open' : ''}`} aria-hidden="true">⌄</span>
        </button>
        <div className="ph2-history-actions">
          <button className="ph2-icon-only" onClick={onEdit} aria-label="Edit phase">✎</button>
          <button className="ph2-icon-only ph2-icon-only-danger" onClick={onDelete} aria-label="Delete phase">×</button>
        </div>
      </div>

      {expanded && (
        <div className="ph2-history-expanded">
          <div className="ph2-target-grid ph2-target-grid-compact">
            <TargetChip label="CAL" value={phase.target_calories} unit="" macro="cal" />
            <TargetChip label="P" value={phase.target_protein_g} unit="g" macro="p" />
            <TargetChip label="C" value={phase.target_carbs_g} unit="g" macro="c" />
            <TargetChip label="F" value={phase.target_fat_g} unit="g" macro="f" />
            <TargetChip label="FIB" value={phase.target_fiber_g} unit="g" macro="fib" />
          </div>

          <div className="ph2-section-head ph2-refeeds-head">
            <h4 className="ph2-section-title">REFEEDS</h4>
            <span className="ph2-section-rule" />
            {phase.phase_type === 'cut' && (
              <button className="ph2-add-refeed-btn" onClick={onAddRefeed}>
                + Add Refeed
              </button>
            )}
          </div>
          {sortedRefeeds.length === 0 ? (
            <div className="ph2-refeeds-empty">
              {phase.phase_type === 'cut' ? 'No refeeds recorded in this cut.' : 'Refeeds are only used during cuts.'}
            </div>
          ) : (
            <ul className="ph2-refeed-list">
              {sortedRefeeds.map(r => (
                <li
                  key={r.id}
                  className={[
                    'ph2-refeed-card',
                    pulseRefeedId === r.id ? 'ph2-refeed-card-new' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <RefeedCard
                    refeed={r}
                    onEdit={() => onEditRefeed(r)}
                    onDelete={() => onDeleteRefeed(r.id)}
                    onEndNow={() => onEndRefeedNow(r)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
