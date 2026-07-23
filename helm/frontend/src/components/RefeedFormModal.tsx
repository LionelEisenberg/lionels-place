import { useEffect, useState } from 'react';
import type {
  PhaseResponse, RefeedCreate, RefeedResponse, RefeedUpdate,
} from '../api';

interface Props {
  parentPhase: PhaseResponse;
  initial?: RefeedResponse;
  onCancel: () => void;
  onSubmit: (data: RefeedCreate | RefeedUpdate) => Promise<void>;
}

export function RefeedFormModal({ parentPhase, initial, onCancel, onSubmit }: Props) {
  const [startDate, setStartDate] = useState(initial?.start_date ?? parentPhase.start_date);
  const [endDate, setEndDate] = useState(initial?.end_date ?? '');
  const [calories, setCalories] = useState(String(initial?.target_calories ?? ''));
  const [protein, setProtein] = useState(String(initial?.target_protein_g ?? parentPhase.target_protein_g));
  const [carbs, setCarbs] = useState(String(initial?.target_carbs_g ?? ''));
  const [fat, setFat] = useState(String(initial?.target_fat_g ?? parentPhase.target_fat_g));
  const [fiber, setFiber] = useState(String(initial?.target_fiber_g ?? parentPhase.target_fiber_g));
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

  const minDate = parentPhase.start_date;
  const maxDate = parentPhase.end_date ?? undefined;

  function applyCutMacrosBumpCarbs() {
    // Start from parent macros, bump carbs by 100g, recompute calories
    setProtein(String(parentPhase.target_protein_g));
    setFat(String(parentPhase.target_fat_g));
    setFiber(String(parentPhase.target_fiber_g));
    const newCarbs = parentPhase.target_carbs_g + 100;
    setCarbs(String(newCarbs));
    const newCal = Math.round(
      parentPhase.target_protein_g * 4 + newCarbs * 4 + parentPhase.target_fat_g * 9,
    );
    setCalories(String(newCal));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: RefeedCreate = {
        start_date: startDate,
        end_date: endDate,
        target_calories: Number(calories),
        target_protein_g: Number(protein),
        target_carbs_g: Number(carbs),
        target_fat_g: Number(fat),
        target_fiber_g: Number(fiber),
        notes: notes || null,
      };
      await onSubmit(payload);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="phm-overlay" onClick={onCancel}>
      <div
        className="phm-panel phm-color-refeed"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="phm-refeed-title"
      >
        <header className="phm-header">
          <div className="phm-header-titles">
            <span className="phm-eyebrow">REFEED</span>
            <h2 id="phm-refeed-title" className="phm-title">
              {initial ? 'Edit Refeed' : 'Add Refeed'}
            </h2>
            <p className="phm-subtitle">
              within {parentPhase.phase_type} · {parentPhase.start_date} →{' '}
              {parentPhase.end_date ?? 'ongoing'}
            </p>
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
          <div className="phm-row">
            <label className="phm-field">
              <span className="phm-label">Start</span>
              <input
                type="date"
                className="phm-input phm-input-date"
                value={startDate}
                min={minDate}
                max={maxDate}
                onChange={e => setStartDate(e.target.value)}
                required
              />
            </label>
            <label className="phm-field">
              <span className="phm-label">End</span>
              <input
                type="date"
                className="phm-input phm-input-date"
                value={endDate}
                min={minDate}
                max={maxDate}
                onChange={e => setEndDate(e.target.value)}
                required
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
                onClick={applyCutMacrosBumpCarbs}
                className="phm-prefill-btn"
              >
                <span aria-hidden="true">⚡</span> Cut macros + 100g carbs
              </button>
            </div>
          </div>

          <label className="phm-field">
            <span className="phm-label">Notes</span>
            <textarea
              className="phm-input phm-textarea"
              value={notes ?? ''}
              onChange={e => setNotes(e.target.value)}
            />
          </label>

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
              {submitting ? 'Saving…' : (initial ? 'Save Changes' : 'Add Refeed')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
