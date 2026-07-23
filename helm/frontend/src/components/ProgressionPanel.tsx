/** Inline progression panel for one exercise (charts + session history table).
 *  Extracted verbatim from WorkoutLog.tsx's renderProgressionPanel — no behavior change. */
import type { ExerciseProgressionResponse } from '../api'
import { displayDate } from '../dates'
import {
  parseCardioValue, formatDuration, computeVolume, computeEffectiveVolume,
  getEffectiveMaxWeight, getMaxWeight, hasNegativeWeight, isCardioEntry,
  getEquipClass, getEquipAbbrev,
} from '../utils/workout-row-helpers'

export function ProgressionPanel({
  exercise, muscles, data, activeTab, onTabChange, onClose,
}: {
  exercise: string
  muscles: string
  data: ExerciseProgressionResponse[]
  activeTab: number
  onTabChange: (i: number) => void
  onClose: () => void
}) {
  if (data.length === 0) return null
  const activeVariant = data[activeTab]
  if (!activeVariant) return null

  const sessionsReversed = [...activeVariant.sessions].reverse()
  const isCardio = activeVariant.sessions.every(s => isCardioEntry(s.weight_lbs, activeVariant.equipment_type))

  if (isCardio) {
    const cardioPoints = sessionsReversed.map(s => {
      const parsed = parseCardioValue(s.reps_sets)
      return { date: displayDate(s.date), ...parsed, raw: s.reps_sets, notes: s.notes }
    })
    const hasLaps = cardioPoints.some(p => p.laps !== null)
    const hasDistance = cardioPoints.some(p => p.distance !== null)
    const hasDuration = cardioPoints.some(p => p.duration !== null)
    const distUnit = cardioPoints.find(p => p.distanceUnit)?.distanceUnit || 'mi'

    const maxLaps = Math.max(...cardioPoints.map(p => p.laps ?? 0), 1)
    const maxDist = Math.max(...cardioPoints.map(p => p.distance ?? 0), 1)
    const maxDur = Math.max(...cardioPoints.map(p => p.duration ?? 0), 1)

    return (
      <div className="wo-progression-panel">
        <div className="wo-progression-header">
          <span className="wo-progression-title">
            {exercise}
            <span className={`wo-ex-equipment ${getEquipClass(activeVariant.equipment_type)}`} style={{ marginLeft: 6 }}>
              {getEquipAbbrev(activeVariant.equipment_type)}
            </span>
            {muscles && (
              <span className="wo-progression-muscles">
                {muscles.split(',').map(m => m.trim()).filter(Boolean).map((m, i) => (
                  <span key={i} className="muscle-pill">{m}</span>
                ))}
              </span>
            )}
          </span>
          <button className="wo-progression-close" onClick={() => onClose()}>{'\u2715'}</button>
        </div>

        {data.length > 1 && (
          <div className="wo-prog-equip-tabs">
            {data.map((v, i) => (
              <button key={v.equipment_type}
                className={`wo-filter-chip${i === activeTab ? ' active' : ''}`}
                onClick={() => onTabChange(i)}>
                {v.equipment_type} ({v.sessions.length})
              </button>
            ))}
          </div>
        )}

        <div className="wo-prog-charts">
          {hasLaps && (() => {
            const lapDays = cardioPoints.filter(p => (p.laps ?? 0) > 0).length
            const above40 = cardioPoints.filter(p => (p.laps ?? 0) >= 40).length
            const pct40 = lapDays > 0 ? Math.round((above40 / lapDays) * 100) : 0
            return (
              <div className="wo-vol-chart wo-vol-chart-full">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div className="wo-vol-chart-label" style={{ marginBottom: 0 }}>Laps</div>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 600, fontFamily: 'var(--font-mono)',
                    padding: '2px 8px', borderRadius: 10,
                    color: pct40 >= 50 ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                    background: pct40 >= 50 ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
                  }}>
                    {pct40}% days {'\u2265'} 40 laps
                  </span>
                </div>
                <div className="wo-vol-bars wo-vol-bars-tall">
                  {cardioPoints.map((p, i) => (
                    <div key={i} className="wo-vol-bar"
                      style={{ height: `${((p.laps ?? 0) / maxLaps) * 100}%`, background: (p.laps ?? 0) >= 40 ? 'linear-gradient(to top, rgba(16,185,129,0.3), rgba(16,185,129,0.8))' : 'linear-gradient(to top, rgba(168,85,247,0.25), rgba(168,85,247,0.7))' }}
                      data-tip={`${p.laps} laps`} />
                  ))}
                </div>
                <div className="wo-vol-dates">
                  {cardioPoints.length > 0 && (<><span>{cardioPoints[0].date}</span><span>{cardioPoints[cardioPoints.length - 1].date}</span></>)}
                </div>
              </div>
            )
          })()}
          {hasDistance && (
            <div className="wo-vol-chart">
              <div className="wo-vol-chart-label">Distance ({distUnit})</div>
              <div className="wo-vol-bars">
                {cardioPoints.map((p, i) => (
                  <div key={i} className="wo-vol-bar"
                    style={{ height: `${((p.distance ?? 0) / maxDist) * 100}%`, background: 'linear-gradient(to top, rgba(251,146,60,0.25), rgba(251,146,60,0.7))' }}
                    data-tip={`${p.distance} ${distUnit}`} />
                ))}
              </div>
              <div className="wo-vol-dates">
                {cardioPoints.length > 0 && (<><span>{cardioPoints[0].date}</span><span>{cardioPoints[cardioPoints.length - 1].date}</span></>)}
              </div>
            </div>
          )}
          {hasDuration && (
            <div className="wo-vol-chart">
              <div className="wo-vol-chart-label">Duration</div>
              <div className="wo-vol-bars">
                {cardioPoints.map((p, i) => (
                  <div key={i} className="wo-vol-bar"
                    style={{ height: `${((p.duration ?? 0) / maxDur) * 100}%`, background: 'linear-gradient(to top, rgba(56,189,248,0.25), rgba(56,189,248,0.7))' }}
                    data-tip={p.duration ? formatDuration(p.duration) : ''} />
                ))}
              </div>
              <div className="wo-vol-dates">
                {cardioPoints.length > 0 && (<><span>{cardioPoints[0].date}</span><span>{cardioPoints[cardioPoints.length - 1].date}</span></>)}
              </div>
            </div>
          )}
        </div>

        <div className="wo-prog-history">
          <div className="wo-prog-history-label">Session History</div>
          <table className="wo-prog-table">
            <thead><tr><th>Date</th>{hasLaps && <th>Laps</th>}{hasDistance && <th>Distance</th>}{hasDuration && <th>Duration</th>}<th>Notes</th></tr></thead>
            <tbody>
              {activeVariant.sessions.map((s, i) => {
                const p = parseCardioValue(s.reps_sets)
                return (
                  <tr key={i}>
                    <td className="wo-prog-td-date">{displayDate(s.date)}</td>
                    {hasLaps && <td className="wo-prog-td-reps">{p.laps ?? '\u2014'}</td>}
                    {hasDistance && <td className="wo-prog-td-reps">{p.distance ? `${p.distance} ${p.distanceUnit}` : '\u2014'}</td>}
                    {hasDuration && <td className="wo-prog-td-reps">{p.duration ? formatDuration(p.duration) : '\u2014'}</td>}
                    <td className="wo-prog-td-notes">{s.notes || '\u2014'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const isAssisted = sessionsReversed.some(s => hasNegativeWeight(s.weight_lbs))

  const volumes = sessionsReversed.map(s => ({
    date: displayDate(s.date),
    volume: isAssisted
      ? computeEffectiveVolume(s.weight_lbs, s.reps_sets, s.body_weight)
      : computeVolume(s.weight_lbs, s.reps_sets),
    maxWeight: isAssisted
      ? getEffectiveMaxWeight(s.weight_lbs, s.body_weight)
      : getMaxWeight(s.weight_lbs),
  }))
  const maxVol = Math.max(...volumes.map(v => v.volume), 1)
  const maxWt = Math.max(...volumes.map(v => v.maxWeight), 1)

  return (
    <div className="wo-progression-panel">
      <div className="wo-progression-header">
        <span className="wo-progression-title">
          {exercise}
          <span className={`wo-ex-equipment ${getEquipClass(activeVariant.equipment_type)}`} style={{ marginLeft: 6 }}>
            {getEquipAbbrev(activeVariant.equipment_type)}
          </span>
          {muscles && (
            <span className="wo-progression-muscles">
              {muscles.split(',').map(m => m.trim()).filter(Boolean).map((m, i) => (
                <span key={i} className="muscle-pill">{m}</span>
              ))}
            </span>
          )}
        </span>
        <button className="wo-progression-close" onClick={() => onClose()}>{'\u2715'}</button>
      </div>

      {data.length > 1 && (
        <div className="wo-prog-equip-tabs">
          {data.map((v, i) => (
            <button key={v.equipment_type}
              className={`wo-filter-chip${i === activeTab ? ' active' : ''}`}
              onClick={() => onTabChange(i)}>
              {v.equipment_type} ({v.sessions.length})
            </button>
          ))}
        </div>
      )}

      <div className="wo-prog-charts">
        {/* Volume chart */}
        <div className="wo-vol-chart">
          <div className="wo-vol-chart-label">{isAssisted ? 'Volume (effective lbs \u00D7 reps)' : 'Volume (weight \u00D7 reps)'}</div>
          <div className="wo-vol-bars">
            {volumes.map((v, i) => (
              <div key={i} className="wo-vol-bar"
                style={{ height: `${(v.volume / maxVol) * 100}%`, background: 'linear-gradient(to top, rgba(16,185,129,0.25), rgba(16,185,129,0.65))' }}
                data-tip={`${v.volume.toLocaleString()} lbs`} />
            ))}
          </div>
          <div className="wo-vol-dates">
            {volumes.length > 0 && (<><span>{volumes[0].date}</span><span>{volumes[volumes.length - 1].date}</span></>)}
          </div>
        </div>

        {/* Max weight chart */}
        <div className="wo-vol-chart">
          <div className="wo-vol-chart-label">{isAssisted ? 'Effective Weight (lbs)' : 'Max Weight (lbs)'}</div>
          <div className="wo-vol-bars">
            {volumes.map((v, i) => (
              <div key={i} className="wo-vol-bar"
                style={{ height: `${(v.maxWeight / maxWt) * 100}%`, background: 'linear-gradient(to top, rgba(56,189,248,0.25), rgba(56,189,248,0.65))' }}
                data-tip={`${v.maxWeight} lbs`} />
            ))}
          </div>
          <div className="wo-vol-dates">
            {volumes.length > 0 && (<><span>{volumes[0].date}</span><span>{volumes[volumes.length - 1].date}</span></>)}
          </div>
        </div>
      </div>

      <div className="wo-prog-history">
        <div className="wo-prog-history-label">Session History</div>
        <table className="wo-prog-table">
          <thead><tr><th>Date</th><th>{isAssisted ? 'Effective' : 'Weight'}</th><th>Reps</th><th>Notes</th></tr></thead>
          <tbody>
            {activeVariant.sessions.map((s, i) => {
              const effectiveMax = isAssisted
                ? getEffectiveMaxWeight(s.weight_lbs, s.body_weight)
                : null
              return (
                <tr key={i}>
                  <td className="wo-prog-td-date">{displayDate(s.date)}</td>
                  <td className="wo-prog-td-weight">
                    {isAssisted && effectiveMax !== null
                      ? <>{effectiveMax} lbs <span style={{ opacity: 0.5, fontSize: '0.75rem' }}>({s.weight_lbs})</span></>
                      : <>{s.weight_lbs} lbs</>}
                  </td>
                  <td className="wo-prog-td-reps">{s.reps_sets}</td>
                  <td className="wo-prog-td-notes">{s.notes || '\u2014'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
