/** One server-assembled day: activity-led header (date/Today badge), collapsed
 *  activity chips with headline stats, expanded sport cards, footer with day
 *  aggregates. Editing is per-activity — the edit controller is owned by
 *  WorkoutLog and threaded through to each ActivityBlock. */
import React from 'react'
import type { DayLog, WorkoutResponse } from '../api'
import { displayDate } from '../dates'
import { activityEmoji, activityColor } from '../utils/session-helpers'
import { countSets } from '../utils/workout-row-helpers'
import { chipStats, activityExtras } from '../utils/activity-stats'
import { ActivityBlock, ExHeader, type ActivityEditController } from './ActivityBlock'

/** Re-exported for the page's heatmap tooltip (palette lives with the heatmap helpers). */
export { TYPE_COLORS } from '../utils/workout-heatmap-helpers'

export function DayCard({
  day, isToday, expanded, expandedActivities, flatRows,
  onToggle, onToggleActivity, renderRow, activityEdit, cardRef,
}: {
  day: DayLog
  isToday: boolean
  expanded: boolean
  expandedActivities: Set<number>
  /** Search-narrowed rows: when set, render them flat (no activity sections)
   *  and derive the shown totals from them so the footer matches the display. */
  flatRows?: WorkoutResponse[]
  onToggle: () => void
  onToggleActivity: (id: number) => void
  renderRow: (ex: WorkoutResponse) => React.ReactNode
  activityEdit: ActivityEditController
  cardRef?: (el: HTMLDivElement | null) => void
}) {
  const shownSets = flatRows
    ? flatRows.reduce((n, r) => n + countSets(r.reps_sets), 0)
    : day.total_sets

  return (
    <div
      ref={cardRef}
      className={`wo-session-card${isToday ? ' wo-today' : ''}`}
      style={{ cursor: !expanded ? 'pointer' : undefined }}
      onClick={!expanded ? onToggle : undefined}
    >
      {/* Day header — clickable */}
      <div
        onClick={expanded ? onToggle : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-sm) var(--space-md)',
          cursor: 'pointer',
          userSelect: 'none',
          background: isToday ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          {/* Date */}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {displayDate(day.date)}
          </span>

          {/* Today badge */}
          {isToday && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase',
              background: 'var(--accent-indigo)', color: '#fff',
              padding: '1px 6px', borderRadius: '4px', letterSpacing: '0.05em',
            }}>
              Today
            </span>
          )}

        </div>

        {/* Chevron */}
        <span style={{
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          fontSize: '1rem',
          color: 'var(--text-muted)',
        }}>
          &#9662;
        </span>
      </div>

      {/* Collapsed: one accent chip per activity with its headline stats */}
      {!expanded && (
        <div className="wo-day-chips">
          {day.sessions.map(a => (
            <span
              key={a.id}
              className="wo-act-chip"
              style={{ ['--acc' as string]: activityColor(a.activity) } as React.CSSProperties}
            >
              {activityEmoji(a.activity)} {a.label}
              <span className="st">{chipStats(a, activityExtras(a))}</span>
            </span>
          ))}
        </div>
      )}

      {/* Expanded body: flat search rows / sport cards */}
      {expanded && (
        <div style={{ padding: '0 var(--space-md) var(--space-md)' }}>
          {flatRows ? (
            <>
              <ExHeader isCardio={day.is_cardio} />
              {flatRows.map(ex => renderRow(ex))}
            </>
          ) : (
            day.sessions.map(a => (
              <ActivityBlock
                key={a.id}
                activity={a}
                date={day.date}
                dayType={day.day_type}
                expanded={expandedActivities.has(a.id)}
                onToggle={() => onToggleActivity(a.id)}
                renderRow={renderRow}
                edit={activityEdit}
              />
            ))
          )}

          {/* Day footer */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            paddingTop: 'var(--space-sm)',
            marginTop: 'var(--space-xs)',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
          }}>
            {/* Stats */}
            <div style={{ display: 'flex', gap: 'var(--space-lg)' }}>
              <span>
                <strong style={{ color: 'var(--text-secondary)' }}>{day.sessions.length}</strong>
                {' '}{day.sessions.length === 1 ? 'Activity' : 'Activities'}
              </span>
              {!day.is_cardio && (
                <span>
                  <strong style={{ color: 'var(--text-secondary)' }}>{shownSets}</strong> Sets
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
