/**
 * QuickAddPanel — chip row of pinned + popular MealItems with a draft tray.
 * Click a chip to add it to the draft, then "Log Meal" commits the meal.
 */

import { useEffect, useState } from 'react';
import {
  getQuickAdd, pinQuickAddItem, unpinQuickAddItem, logQuickAddMeal,
  type QuickAddItem, type QuickAddData, type MealItemData,
} from '../api';
import { computeRunningTotals } from '../utils/quick-add-helpers';
import { todayISO } from '../dates';

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const;
type MealType = typeof MEAL_TYPES[number];

interface Props {
  onLogged: () => void;
}

export default function QuickAddPanel({ onLogged }: Props) {
  const [data, setData] = useState<QuickAddData | null>(null);
  const [draft, setDraft] = useState<MealItemData[]>([]);
  const [mealType, setMealType] = useState<MealType>('Lunch');
  const [logDate, setLogDate] = useState(todayISO());
  const [showAll, setShowAll] = useState(false);
  const [logging, setLogging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const d = await getQuickAdd();
      setData(d);
    } catch (err) {
      console.error('Failed to load quick-add data:', err);
    }
  };

  useEffect(() => { refresh(); }, []);

  const itemFromChip = (c: QuickAddItem): MealItemData => ({
    name: c.name, quantity: c.quantity,
    calories: c.calories, protein_g: c.protein_g, carbs_g: c.carbs_g,
    fat_g: c.fat_g, fiber_g: c.fiber_g,
  });

  const addToDraft = (chip: QuickAddItem) => {
    setDraft(d => [...d, itemFromChip(chip)]);
  };

  const removeFromDraft = (idx: number) => {
    setDraft(d => d.filter((_, i) => i !== idx));
  };

  const togglePin = async (chip: QuickAddItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (chip.is_pinned && chip.pin_id != null) {
        await unpinQuickAddItem(chip.pin_id);
      } else {
        await pinQuickAddItem(chip.name, chip.quantity);
      }
      await refresh();
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  const handleLog = async () => {
    if (!draft.length || logging) return;
    setLogging(true);
    setError(null);
    try {
      await logQuickAddMeal(mealType, draft, logDate);
      setDraft([]);
      setLogDate(todayISO());
      onLogged();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log meal');
    } finally {
      setLogging(false);
    }
  };

  const totals = computeRunningTotals(draft);
  const popular = data?.popular ?? [];
  const pinned = data?.pinned ?? [];
  const visiblePopular = showAll ? popular.slice(0, 24) : popular.slice(0, 8);
  const hasMore = popular.length > 8 && !showAll;

  if (!data) {
    return null;
  }

  if (pinned.length === 0 && popular.length === 0) {
    return (
      <div className="quick-add-panel quick-add-empty">
        <div className="quick-add-header">
          <span className="quick-add-title">⚡ Quick Add</span>
        </div>
        <div className="quick-add-empty-msg">Log some meals to see your favorites here.</div>
      </div>
    );
  }

  return (
    <div className="quick-add-panel">
      <div className="quick-add-header">
        <span className="quick-add-title">⚡ Quick Add</span>
        <span className="quick-add-subtitle">Pinned + last {data.window_days} days</span>
      </div>

      <div className="quick-add-chips">
        {pinned.map(c => (
          <ChipBtn key={`pin-${c.pin_id}`} chip={c} onAdd={addToDraft} onTogglePin={togglePin} />
        ))}
        {pinned.length > 0 && popular.length > 0 && <div className="quick-add-divider" />}
        {visiblePopular.map((c, i) => (
          <ChipBtn key={`pop-${c.name}-${c.quantity}-${i}`} chip={c} onAdd={addToDraft} onTogglePin={togglePin} />
        ))}
        {hasMore && (
          <button className="quick-add-show-more" onClick={() => setShowAll(true)}>
            +{popular.length - 8} more
          </button>
        )}
      </div>

      <div className="quick-add-tray">
        {draft.length === 0 ? (
          <span className="quick-add-tray-empty">Click items above to build a meal.</span>
        ) : (
          <>
            <div className="quick-add-tray-items">
              {draft.map((it, idx) => (
                <span className="quick-add-tray-chip" key={idx}>
                  {it.name} {it.quantity}
                  <span className="quick-add-tray-x" onClick={() => removeFromDraft(idx)}>×</span>
                </span>
              ))}
            </div>
            <span className="quick-add-tray-totals">
              <span className="lbl">Σ</span> {Math.round(totals.calories)} ·{' '}
              <span style={{ color: 'var(--color-protein)' }}>{Math.round(totals.protein_g)}P</span> ·{' '}
              <span style={{ color: 'var(--color-carbs)' }}>{Math.round(totals.carbs_g)}C</span> ·{' '}
              <span style={{ color: 'var(--color-fat)' }}>{Math.round(totals.fat_g)}F</span>
            </span>
          </>
        )}
        <div className="quick-add-tray-actions">
          {draft.length > 0 && (
            <button className="quick-add-clear" onClick={() => setDraft([])}>Clear</button>
          )}
          <input
            type="date"
            className="quick-add-date-input"
            value={logDate}
            onChange={e => setLogDate(e.target.value)}
            title="Date to log this meal"
          />
          <select
            className="quick-add-meal-select"
            value={mealType}
            onChange={e => setMealType(e.target.value as MealType)}
          >
            {MEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button
            className="quick-add-log-btn"
            onClick={handleLog}
            disabled={draft.length === 0 || logging}
          >
            {logging ? 'Logging…' : 'Log Meal'}
          </button>
        </div>
      </div>

      {error && <div className="quick-add-error">{error}</div>}
    </div>
  );
}

function ChipBtn({
  chip, onAdd, onTogglePin,
}: {
  chip: QuickAddItem;
  onAdd: (c: QuickAddItem) => void;
  onTogglePin: (c: QuickAddItem, e: React.MouseEvent) => void;
}) {
  return (
    <button
      className={`quick-add-chip${chip.is_pinned ? ' pinned' : ''}`}
      onClick={() => onAdd(chip)}
      title={`${chip.name} ${chip.quantity} — ${Math.round(chip.calories)} cal`}
    >
      <span className="quick-add-pin-toggle" onClick={e => onTogglePin(chip, e)}>
        {chip.is_pinned ? '★' : '☆'}
      </span>
      <span className="quick-add-name">{chip.name}</span>
      {chip.quantity && <span className="quick-add-qty">{chip.quantity}</span>}
      <span className="quick-add-cal">{Math.round(chip.calories)}cal</span>
    </button>
  );
}
