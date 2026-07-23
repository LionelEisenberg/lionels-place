import { type WorkoutPlan } from '../api'

export function WorkoutPlanCard({ plan }: { plan: WorkoutPlan }) {
  const categoryColor: Record<string, string> = {
    Push: 'var(--accent-rose)',
    Pull: 'var(--accent-indigo)',
    Legs: 'var(--accent-amber)',
    Rest: 'var(--accent-sky)',
  }
  const color = categoryColor[plan.workout_type] || 'var(--accent-indigo)'

  return (
    <div style={{ width: '100%', fontSize: '0.88rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <span style={{
          background: color, color: '#fff', fontWeight: 700, fontSize: '0.75rem',
          padding: '3px 10px', borderRadius: 'var(--radius-full)', textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>{plan.workout_type}</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{plan.date_label}</span>
      </div>

      {/* Exercise table */}
      <div style={{ overflowX: 'auto', marginBottom: '12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-medium)' }}>
              <th style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>#</th>
              <th style={{ padding: '7px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>Exercise</th>
              <th style={{ padding: '7px 10px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>Weight</th>
              <th style={{ padding: '7px 10px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>Sets × Reps</th>
              <th style={{ padding: '7px 34px 7px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' }}>vs. Last Session</th>
            </tr>
          </thead>
          <tbody>
            {plan.exercises.map((ex, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-secondary)' }}>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{i + 1}</td>
                <td style={{ padding: '7px 10px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{ex.name}</strong>
                  {ex.warm_up && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>Warm-up: {ex.warm_up}</div>}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: 'var(--font-mono)', color }}>
                  {ex.weights.length === 1 ? ex.weights[0] : ex.weights.join(' / ')}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  {ex.sets.join(', ')}
                </td>
                <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  {ex.previous_date && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>{ex.previous_date}:</span> {ex.previous_weight} {ex.previous_reps}</div>
                  )}
                  {ex.overload_note && <div style={{ color: 'var(--accent-emerald)', marginTop: '2px' }}>↑ {ex.overload_note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Session notes */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {plan.session_notes.duration && (
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>⏱️ <strong>Duration:</strong> {plan.session_notes.duration}</div>
        )}
        {plan.session_notes.cardio && (
          <div style={{ fontSize: '0.78rem', color: 'var(--accent-sky)' }}>🏊 <strong>Cardio:</strong> {plan.session_notes.cardio}</div>
        )}
        {plan.session_notes.caveats && (
          <div style={{ fontSize: '0.78rem', color: 'var(--accent-amber)', marginTop: '4px' }}>⚠️ {plan.session_notes.caveats}</div>
        )}
      </div>
    </div>
  )
}
