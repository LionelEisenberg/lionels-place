import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { listTasks, type TimeBlockResponse, type TimeBlockCreate, type TimeBlockUpdate, type TaskResponse } from '../../api'
import { toLocalISO } from '../../dates'

interface BlockPopoverProps {
  block?: TimeBlockResponse
  defaultDate?: string
  defaultStartTime?: string
  defaultEndTime?: string
  position: { x: number; y: number }
  onSave: (data: TimeBlockCreate | TimeBlockUpdate) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}

const CATEGORIES = [
  { value: 'workout', label: 'Workout', color: 'emerald' },
  { value: 'meals', label: 'Meals', color: 'amber' },
  { value: 'leetcode', label: 'Leetcode', color: 'indigo' },
  { value: 'job_search', label: 'Job Search', color: 'orange' },
  { value: 'productivity', label: 'Productivity', color: 'violet' },
  { value: 'personal', label: 'Personal', color: 'sky' },
]

const COLORS = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet', 'orange', 'pink']

const COLOR_MAP: Record<string, string> = {
  indigo: 'var(--accent-indigo)',
  emerald: 'var(--accent-emerald)',
  amber: 'var(--accent-amber)',
  rose: 'var(--accent-rose)',
  sky: 'var(--accent-sky)',
  violet: 'var(--accent-violet)',
  orange: 'var(--accent-orange)',
  pink: 'var(--accent-pink)',
}

export default function BlockPopover({
  block, defaultDate, defaultStartTime, defaultEndTime,
  position, onSave, onDelete, onClose,
}: BlockPopoverProps) {
  const isEdit = !!block

  const [name, setName] = useState(block?.name || '')
  const [category, setCategory] = useState(block?.category || 'personal')
  const [color, setColor] = useState(block?.color || 'indigo')
  const [startTime, setStartTime] = useState(block?.start_time || defaultStartTime || '09:00')
  const [endTime, setEndTime] = useState(block?.end_time || defaultEndTime || '10:00')
  const [status, setStatus] = useState(block?.status || 'planned')
  const [taskId, setTaskId] = useState<number | null>(block?.task_id || null)
  const [notes, setNotes] = useState(block?.notes || '')
  const [tasks, setTasks] = useState<TaskResponse[]>([])

  useEffect(() => {
    if (!isEdit) {
      const cat = CATEGORIES.find(c => c.value === category)
      if (cat) setColor(cat.color)
    }
  }, [category, isEdit])

  useEffect(() => {
    listTasks().then(setTasks).catch(() => {})
  }, [])

  // Clamp popover within viewport
  const popoverRef = useRef<HTMLDivElement>(null)
  const [clampedPos, setClampedPos] = useState(position)

  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    let { x, y } = position
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad
    if (x < pad) x = pad
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad
    if (y < pad) y = pad
    setClampedPos({ x, y })
  }, [position])

  const handleSubmit = async () => {
    if (!name.trim()) return
    if (isEdit) {
      const data: TimeBlockUpdate = {
        name: name.trim(),
        start_time: startTime,
        end_time: endTime,
        category,
        color,
        status,
        task_id: taskId,
        notes: notes.trim() || null,
      }
      await onSave(data)
    } else {
      const data: TimeBlockCreate = {
        date: defaultDate || toLocalISO(new Date()),
        name: name.trim(),
        start_time: startTime,
        end_time: endTime,
        category,
        color,
        status,
        task_id: taskId,
        notes: notes.trim() || null,
      }
      await onSave(data)
    }
  }

  return (
    <div
      ref={popoverRef}
      className="block-popover"
      style={{ left: clampedPos.x, top: clampedPos.y }}
      onClick={e => e.stopPropagation()}
    >
      <div className="block-popover-header">
        <span>{isEdit ? 'Edit Block' : 'New Block'}</span>
        <button className="block-popover-close" onClick={onClose}>×</button>
      </div>

      <div className="block-popover-body">
        <input
          className="block-popover-input"
          placeholder="Block name..."
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          autoFocus
        />

        <div className="block-popover-row">
          <label>Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="block-popover-row">
          <label>Color</label>
          <div className="block-popover-colors">
            {COLORS.map(c => (
              <button
                key={c}
                className={`block-popover-color-btn ${c === color ? 'active' : ''}`}
                style={{ background: COLOR_MAP[c] }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="block-popover-row block-popover-time-row">
          <div>
            <label>Start</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} step="900" />
          </div>
          <div>
            <label>End</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} step="900" />
          </div>
        </div>

        {isEdit && (
          <div className="block-popover-row">
            <label>Status</label>
            <div className="block-popover-status-btns">
              {(['planned', 'done', 'skipped'] as const).map(s => (
                <button
                  key={s}
                  className={`block-popover-status-btn ${s === status ? 'active' : ''} status-${s}`}
                  onClick={() => setStatus(s)}
                >
                  {s === 'planned' && '○'}
                  {s === 'done' && '✓'}
                  {s === 'skipped' && '✗'}
                  {' '}{s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="block-popover-row">
          <label>Link Task</label>
          <select value={taskId ?? ''} onChange={e => setTaskId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {tasks.filter(t => t.status !== 'done').map(t => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>

        <div className="block-popover-row">
          <label>Notes</label>
          <textarea
            className="block-popover-textarea"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes..."
          />
        </div>
      </div>

      <div className="block-popover-footer">
        {isEdit && onDelete && (
          <button className="block-popover-delete-btn" onClick={onDelete}>Delete</button>
        )}
        <div style={{ flex: 1 }} />
        <button className="block-popover-cancel-btn" onClick={onClose}>Cancel</button>
        <button className="block-popover-save-btn" onClick={handleSubmit}>
          {isEdit ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  )
}
