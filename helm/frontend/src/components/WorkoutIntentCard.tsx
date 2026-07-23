import type { WorkoutIntentData } from '../api';
import { activityDisplayLabel } from '../utils/workout-helpers';

export function WorkoutIntentCard({ data }: { data: WorkoutIntentData }) {
  return (
    <>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{activityDisplayLabel(data.activity, data.label)}</div>
      {data.exercises.map((ex, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          <strong>{ex.exercise}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}> ({ex.targeted_muscle_group})</span>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            {ex.category} | W: {ex.weight_lbs} | R: {ex.reps_sets}
            {ex.notes && <span style={{ color: 'var(--accent-amber)' }}> — {ex.notes}</span>}
          </div>
        </div>
      ))}
      {data.session_notes && (
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4 }}>📝 {data.session_notes}</div>
      )}
    </>
  );
}
