import { useEffect, useState } from 'react';
import type {
  PhaseCreate, PhaseResponse, PhaseType, PhaseUpdate,
} from '../api';
import { prefillMacrosForPhaseType } from '../utils/phase-helpers';

interface Props {
  initial?: PhaseResponse;             // present = edit mode
  currentOpenPhase: PhaseResponse | null;   // for the auto-close warning
  currentWeightLbs: number | null;
  tdee: number | null;
  onCancel: () => void;
  onSubmit: (data: PhaseCreate | PhaseUpdate) => Promise<void>;
}

const TODAY = new Date().toISOString().slice(0, 10);

const PHASE_OPTIONS: { value: PhaseType; label: string }[] = [
  { value: 'cut',         label: 'Cut' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'bulk',        label: 'Bulk' },
];

export function PhaseFormModal({
  initial, currentOpenPhase, currentWeightLbs, tdee, onCancel, onSubmit,
}: Props) {
  const [phaseType, setPhaseType] = useState<PhaseType>(initial?.phase_type ?? 'cut');
  const [startDate, setStartDate] = useState(initial?.start_date ?? TODAY);
  const [endDate, setEndDate] = useState(initial?.end_date ?? '');
  const [calories, setCalories] = useState(String(initial?.target_calories ?? ''));
  const [protein, setProtein] = useState(String(initial?.target_protein_g ?? ''));
  const [carbs, setCarbs] = useState(String(initial?.target_carbs_g ?? ''));
  const [fat, setFat] = useState(String(initial?.target_fat_g ?? ''));
  const [fiber, setFiber] = useState(String(initial?.target_fiber_g ?? ''));
  const [targetWeight, setTargetWeight] = useState(String(initial?.target_weight_lbs ?? ''));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const willCloseCurrent =
    !initial &&
    currentOpenPhase !== null &&
    startDate >= currentOpenPhase.start_date;

  function applyPrefill() {
    if (!currentWeightLbs || !tdee) {
      setError('Need a recent weight and TDEE to prefill — enter manually.');
      return;
    }
    const m = prefillMacrosForPhaseType(phaseType, currentWeightLbs, tdee);
    setCalories(String(m.target_calories));
    setProtein(String(m.target_protein_g));
    setCarbs(String(m.target_carbs_g));
    setFat(String(m.target_fat_g));
    setFiber(String(m.target_fiber_g));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: PhaseCreate = {
        phase_type: phaseType,
        start_date: startDate,
        end_date: endDate || null,
        target_calories: Number(calories),
        target_protein_g: Number(protein),
        target_carbs_g: Number(carbs),
        target_fat_g: Number(fat),
        target_fiber_g: Number(fiber),
        target_weight_lbs: showTargetWeight && targetWeight ? Number(targetWeight) : null,
        notes: notes || null,
      };
      await onSubmit(payload);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const showTargetWeight = phaseType !== 'maintenance';
  const phaseColorClass = `phm-color-${phaseType}`;

  return (
    <div className="phm-overlay" onClick={onCancel}>
      <div
        className={`phm-panel ${phaseColorClass}`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="phm-title"
      >
        <header className="phm-header">
          <div className="phm-header-titles">
            <span className="phm-eyebrow">PHASE</span>
            <h2 id="phm-title" className="phm-title">
              {initial ? 'Edit Phase' : 'New Phase'}
            </h2>
          </div>
          <button
            type="button"
            className="phm-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <form onSubmit={handleSubmit} className="phm-body">
          {/* Phase type — segmented control */}
          <fieldset className="phm-field">
            <legend className="phm-label">Phase type</legend>
            <div className="phm-segmented" role="radiogroup">
              {PHASE_OPTIONS.map(opt => (
                <label
                  key={opt.value}
                  className={[
                    'phm-segment',
                    `phm-segment-${opt.value}`,
                    phaseType === opt.value ? 'phm-segment-active' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <input
                    type="radio"
                    name="phase-type"
                    value={opt.value}
                    checked={phaseType === opt.value}
                    onChange={() => setPhaseType(opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="phm-row">
            <label className="phm-field">
              <span className="phm-label">Start date</span>
              <input
                type="date"
                className="phm-input phm-input-date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
              />
            </label>
            <label className="phm-field">
              <span className="phm-label">End date <span className="phm-label-opt">optional</span></span>
              <input
                type="date"
                className="phm-input phm-input-date"
                value={endDate ?? ''}
                onChange={e => setEndDate(e.target.value)}
              />
            </label>
          </div>

          <div className="phm-row">
            <label className="phm-field">
              <span className="phm-label">Calories</span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  className="phm-input phm-input-num"
                  value={calories}
                  onChange={e => setCalories(e.target.value)}
                  required
                />
                <span className="phm-num-suffix">kcal</span>
              </div>
            </label>
            <label className="phm-field">
              <span className="phm-label">Protein</span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  className="phm-input phm-input-num"
                  value={protein}
                  onChange={e => setProtein(e.target.value)}
                  required
                />
                <span className="phm-num-suffix">g</span>
              </div>
            </label>
          </div>
          <div className="phm-row">
            <label className="phm-field">
              <span className="phm-label">Carbs</span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  className="phm-input phm-input-num"
                  value={carbs}
                  onChange={e => setCarbs(e.target.value)}
                  required
                />
                <span className="phm-num-suffix">g</span>
              </div>
            </label>
            <label className="phm-field">
              <span className="phm-label">Fat</span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  className="phm-input phm-input-num"
                  value={fat}
                  onChange={e => setFat(e.target.value)}
                  required
                />
                <span className="phm-num-suffix">g</span>
              </div>
            </label>
          </div>
          <div className="phm-row">
            <label className="phm-field">
              <span className="phm-label">Fiber</span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  className="phm-input phm-input-num"
                  value={fiber}
                  onChange={e => setFiber(e.target.value)}
                  required
                />
                <span className="phm-num-suffix">g</span>
              </div>
            </label>
            <div className="phm-field phm-field-prefill">
              <span className="phm-label phm-label-invisible">Prefill</span>
              <button
                type="button"
                onClick={applyPrefill}
                className="phm-prefill-btn"
              >
                <span aria-hidden="true">⚡</span> Smart prefill for {phaseType}
              </button>
            </div>
          </div>

          {showTargetWeight && (
            <label className="phm-field">
              <span className="phm-label">
                Target weight <span className="phm-label-opt">optional</span>
              </span>
              <div className="phm-num-wrap">
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  className="phm-input phm-input-num"
                  value={targetWeight}
                  onChange={e => setTargetWeight(e.target.value)}
                />
                <span className="phm-num-suffix">lbs</span>
              </div>
            </label>
          )}

          <label className="phm-field">
            <span className="phm-label">Notes</span>
            <textarea
              className="phm-input phm-textarea"
              value={notes ?? ''}
              onChange={e => setNotes(e.target.value)}
            />
          </label>

          {willCloseCurrent && (
            <p className="phm-warn">
              <span className="phm-warn-prefix">HEADS UP ·</span>
              This will end your current {currentOpenPhase!.phase_type} on {startDate} − 1.
            </p>
          )}
          {error && (
            <p className="phm-error">
              <span className="phm-error-prefix">ERROR ·</span> {error}
            </p>
          )}

          <footer className="phm-footer">
            <button type="button" onClick={onCancel} className="phm-btn phm-btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="phm-btn phm-btn-primary"
            >
              {submitting ? 'Saving…' : (initial ? 'Save Changes' : 'Create Phase')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
