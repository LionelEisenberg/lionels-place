/** One activity inside a day card, rendered as a sport-specific telemetry card:
 *  instrument-cluster hero numerals, a per-sport signature texture, and — for
 *  strength — the exercise table folded into the card body. Clicking the card
 *  header/cluster still toggles the existing SessionPanel (unchanged). */
import React from 'react'
import type { ActivityResponse, WorkoutResponse } from '../api'
import { SessionPanel } from './SessionPanel'
import { activityEmoji, activityColor, formatRange } from '../utils/session-helpers'
import { statTiles, activityExtras } from '../utils/activity-stats'
import { TYPE_COLORS, type WorkoutType } from '../utils/workout-heatmap-helpers'

/** Column headers for a block of exercise rows. */
export const ExHeader = ({ isCardio }: { isCardio: boolean }) => (
  <div className="wo-ex-header">
    <span>{isCardio ? 'Activity' : 'Exercise'}</span>
    <span style={{ textAlign: 'center' }}>{isCardio ? 'Dist / Vol' : 'Weight'}</span>
    <span style={{ textAlign: 'center' }}>{isCardio ? 'Duration' : 'Reps'}</span>
    <span style={{ textAlign: 'center' }}>vs Last</span>
    <span>Notes</span>
  </div>
)

/** Sport family for card styling: strength/run/bike/swim; everything else
 *  (row, hike, elliptical, stairs, generic cardio) shares the 'cardio' card. */
function sportOf(activity: string): string {
  return ['strength', 'run', 'bike', 'swim'].includes(activity) ? activity : 'cardio'
}

/** Per-activity edit flow, owned by WorkoutLog and threaded through DayCard.
 *  ActivityBlock only decides WHERE the edit UI renders; the rows themselves
 *  come from renderRows so all draft state stays in the page. */
export interface ActivityEditController {
  editingId: number | null
  saving: boolean
  start: (a: ActivityResponse) => void
  cancel: () => void
  save: () => void
  renderRows: (a: ActivityResponse, date: string) => React.ReactNode
}

export function ActivityBlock({
  activity, date, dayType, expanded, onToggle, renderRow, edit,
}: {
  activity: ActivityResponse
  date: string
  /** Day's PPL classification — shown as a tag on the strength card. */
  dayType?: string | null
  expanded: boolean
  onToggle: () => void
  renderRow: (ex: WorkoutResponse) => React.ReactNode
  edit: ActivityEditController
}) {
  // Cardio is always expandable (laps + full progression are worth seeing even
  // with no Google session / HR); strength still needs a Google session for its panel.
  const hasPanel = activity.google_session_id != null || activity.category === 'cardio'
  const isEditing = edit.editingId === activity.id
  const tiles = statTiles(activity, activityExtras(activity))
  const heroes = tiles.filter(t => t.hero)
  const stats = tiles.filter(t => !t.hero)
  const range = formatRange(activity.start, activity.end)
  const toggle = !isEditing && hasPanel ? onToggle : undefined

  return (
    <div
      className={`wo-sport-card sport-${sportOf(activity.activity)}${expanded ? ' open' : ''}`}
      style={{ ['--acc' as string]: activityColor(activity.activity) } as React.CSSProperties}
    >
      <div className={`wo-sport-top${toggle ? ' clickable' : ''}`} onClick={toggle}>
        <div className="wo-sport-badge">{activityEmoji(activity.activity)}</div>
        <div className="wo-sport-name">{activity.label}</div>
        {activity.activity === 'strength' && dayType && (
          <span
            className="wo-sport-ppl"
            style={{ ['--ppl' as string]: TYPE_COLORS[dayType as WorkoutType] ?? 'var(--accent-indigo)' } as React.CSSProperties}
          >
            {dayType}
          </span>
        )}
        <div className="wo-sport-topright" onClick={e => e.stopPropagation()}>
          {range && <span className="wo-sport-range">{range}</span>}
          {isEditing ? (
            <span className="wo-sport-actions">
              <button className="wo-session-action-btn" onClick={edit.cancel} disabled={edit.saving}>Cancel</button>
              <button
                className="btn btn-primary"
                style={{ fontSize: '0.72rem', padding: '4px 14px' }}
                onClick={edit.save}
                disabled={edit.saving}
              >
                {edit.saving ? 'Saving…' : 'Save'}
              </button>
            </span>
          ) : (
            <button className="wo-sport-edit" title="Edit this activity" onClick={() => edit.start(activity)}>
              {'✏️'}
            </button>
          )}
        </div>
      </div>

      {tiles.length > 0 && (
        <div className={`wo-sport-cluster${toggle ? ' clickable' : ''}`} onClick={toggle}>
          {heroes.length > 0 && (
            <div className="wo-sport-heroes">
              {heroes.map((t, i) => (
                <div key={i} className="wo-sport-hero">
                  <span className="v">{t.v}</span>
                  <span className="u">{t.u}</span>
                </div>
              ))}
            </div>
          )}
          {stats.length > 0 && (
            <div className="wo-sport-strip">
              {stats.map((t, i) => (
                <span key={i} className="wo-sport-stat"><b>{t.v}</b> {t.u}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {activity.notes && !isEditing && (
        <div className="wo-sport-notes">{activity.notes}</div>
      )}

      {expanded && !isEditing && (
        <div className="wo-sport-panel">
          <SessionPanel session={activity} date={date} />
        </div>
      )}

      {isEditing ? (
        <div className="wo-sport-table">
          {activity.category !== 'cardio' && <ExHeader isCardio={false} />}
          {edit.renderRows(activity, date)}
        </div>
      ) : (
        activity.category !== 'cardio' && activity.exercises.length > 0 && (
          <div className="wo-sport-table">
            <ExHeader isCardio={false} />
            {activity.exercises.map(ex => renderRow(ex))}
          </div>
        )
      )}
    </div>
  )
}
