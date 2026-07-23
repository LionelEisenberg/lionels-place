import { useState, useEffect, useCallback } from 'react'
import {
  listTimeBlocks, createTimeBlock, updateTimeBlock, deleteTimeBlock,
  applyTemplate, clearWeekBlocks, listDaily,
  type TimeBlockResponse, type TimeBlockCreate, type TimeBlockUpdate,
} from '../api'
import { toLocalISO } from '../dates'
import WeekGrid from '../components/schedule/WeekGrid'
import TemplateEditor from '../components/schedule/TemplateEditor'
import WeeklyReview from '../components/schedule/WeeklyReview'

function getMonday(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return toLocalISO(d)
}

function addWeeks(dateStr: string, weeks: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return toLocalISO(d)
}

function formatWeekRange(monday: string): string {
  const start = new Date(monday + 'T00:00:00')
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const startStr = start.toLocaleDateString('en-US', opts)
  const endStr = end.toLocaleDateString('en-US', { ...opts, year: 'numeric' })
  return `${startStr} – ${endStr}`
}

export default function Schedule() {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  const [blocks, setBlocks] = useState<TimeBlockResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [showTemplateEditor, setShowTemplateEditor] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [habitData, setHabitData] = useState<Record<string, Record<string, boolean>>>({})

  useEffect(() => {
    const endDate = (() => {
      const d = new Date(weekStart + 'T00:00:00')
      d.setDate(d.getDate() + 6)
      return toLocalISO(d)
    })()

    listDaily(weekStart, endDate)
      .then(summaries => {
        const map: Record<string, Record<string, boolean>> = {}
        for (const s of summaries) {
          map[s.date] = {
            workout: !!s.habit_workout,
            clean: !!s.habit_clean,
            productivity: !!s.habit_productivity,
            sleep: !!s.habit_sleep,
            love: !!s.habit_love,
            habit: !!s.habit_custom,
          }
        }
        setHabitData(map)
      })
      .catch(() => {})
  }, [weekStart])

  const loadBlocks = useCallback(async () => {
    try {
      const b = await listTimeBlocks(weekStart)
      setBlocks(b)
    } catch { /* ignore */ }
    setLoading(false)
  }, [weekStart])

  useEffect(() => {
    setLoading(true)
    loadBlocks()
  }, [loadBlocks])

  const handlePrev = () => setWeekStart(s => addWeeks(s, -1))
  const handleNext = () => setWeekStart(s => addWeeks(s, 1))
  const handleToday = () => setWeekStart(getMonday(new Date()))

  const handleCreateBlock = async (data: TimeBlockCreate) => {
    try {
      await createTimeBlock(data)
      await loadBlocks()
    } catch { /* ignore */ }
  }

  const handleUpdateBlock = async (id: number, data: TimeBlockUpdate) => {
    try {
      await updateTimeBlock(id, data)
      await loadBlocks()
    } catch { /* ignore */ }
  }

  const handleDeleteBlock = async (id: number) => {
    try {
      await deleteTimeBlock(id)
      await loadBlocks()
    } catch { /* ignore */ }
  }

  const handleApplyTemplate = async () => {
    try {
      await applyTemplate(weekStart)
      await loadBlocks()
    } catch { /* ignore */ }
  }

  const handleClearWeek = async () => {
    if (!confirm('Clear all blocks for this week?')) return
    try {
      await clearWeekBlocks(weekStart)
      await loadBlocks()
    } catch { /* ignore */ }
  }

  const todayMonday = getMonday(new Date())
  const isCurrentWeek = weekStart === todayMonday

  const totalBlocks = blocks.length
  const doneBlocks = blocks.filter(b => b.status === 'done' || b.auto_status === 'done').length
  const skippedBlocks = blocks.filter(b => b.status === 'skipped').length

  return (
    <div className="schedule-page">
      {/* Navigation bar */}
      <div className="schedule-nav">
        <button className="schedule-nav-btn" onClick={handlePrev}>← Prev</button>
        <div className="schedule-nav-center">
          <div className="schedule-week-label">{formatWeekRange(weekStart)}</div>
        </div>
        <div className="schedule-nav-actions">
          {!isCurrentWeek && (
            <button className="schedule-nav-btn" onClick={handleToday}>Today</button>
          )}
          <button className="schedule-nav-btn" onClick={handleNext}>Next →</button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="schedule-stats-bar">
        <span className="schedule-stat">
          <span className="schedule-stat-dot" style={{ background: 'var(--accent-emerald)' }} />
          {doneBlocks}/{totalBlocks} done
        </span>
        <span className="schedule-stat">
          <span className="schedule-stat-dot" style={{ background: 'var(--accent-rose)' }} />
          {skippedBlocks} skipped
        </span>
        <div className="schedule-toolbar-actions">
          <button className="schedule-toolbar-btn" onClick={() => setShowTemplateEditor(true)} title="Edit Template">⚙</button>
          <button className="schedule-toolbar-btn" onClick={() => setShowReview(!showReview)} title="Weekly Review">📊</button>
          <button className="schedule-toolbar-btn" onClick={handleApplyTemplate} title="Apply Template to This Week">📋 Apply Template</button>
          <button className="schedule-toolbar-btn" onClick={handleClearWeek} title="Clear All Blocks This Week" style={{ color: 'var(--accent-rose)' }}>🗑 Clear Week</button>
        </div>
      </div>

      {/* Main content */}
      {loading ? (
        <div className="loading-overlay"><span className="loading-spinner" /></div>
      ) : (
        <WeekGrid
          weekStart={weekStart}
          blocks={blocks}
          habitData={habitData}
          onCreate={handleCreateBlock}
          onUpdate={handleUpdateBlock}
          onDelete={handleDeleteBlock}
        />
      )}
      {showTemplateEditor && (
        <TemplateEditor
          onClose={() => setShowTemplateEditor(false)}
          onApply={handleApplyTemplate}
        />
      )}
      {showReview && (
        <WeeklyReview
          weekStart={weekStart}
          onClose={() => setShowReview(false)}
        />
      )}
    </div>
  )
}
