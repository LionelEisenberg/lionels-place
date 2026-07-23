import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listTemplateBlocks, createTemplateBlock, updateTemplateBlock, deleteTemplateBlock,
  type TemplateBlockResponse, type TemplateBlockCreate, type TemplateBlockUpdate,
} from '../../api'

interface TemplateEditorProps {
  onClose: () => void
  onApply: () => Promise<void>
}

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

const CATEGORIES = [
  { value: 'workout', label: 'Workout', color: 'emerald' },
  { value: 'meals', label: 'Meals', color: 'amber' },
  { value: 'leetcode', label: 'Leetcode', color: 'indigo' },
  { value: 'job_search', label: 'Job Search', color: 'orange' },
  { value: 'productivity', label: 'Productivity', color: 'violet' },
  { value: 'personal', label: 'Personal', color: 'sky' },
]

const CATEGORY_COLOR: Record<string, string> = {
  workout: 'emerald',
  meals: 'amber',
  leetcode: 'indigo',
  job_search: 'orange',
  productivity: 'violet',
  personal: 'sky',
}

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

const HOUR_START = 7
const HOUR_END = 21
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
const SLOT_HEIGHT = 48
const SLOTS_PER_HOUR = 4
const SLOT_PX = SLOT_HEIGHT / SLOTS_PER_HOUR

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatHour(h: number): string {
  if (h === 0) return '12a'
  if (h < 12) return `${h}a`
  if (h === 12) return '12p'
  return `${h - 12}p`
}

export default function TemplateEditor({ onClose, onApply }: TemplateEditorProps) {
  const [templates, setTemplates] = useState<TemplateBlockResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [editingBlock, setEditingBlock] = useState<TemplateBlockResponse | 'new' | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const [formName, setFormName] = useState('')
  const [formDays, setFormDays] = useState<number[]>([0])
  const [formStart, setFormStart] = useState('09:00')
  const [formEnd, setFormEnd] = useState('10:00')
  const [formCategory, setFormCategory] = useState('personal')
  const [formColor, setFormColor] = useState('sky')

  // Drag-to-create state
  const [dragState, setDragState] = useState<{
    dayIndex: number
    startSlot: number
    currentSlot: number
  } | null>(null)

  const loadTemplates = useCallback(async () => {
    try {
      const t = await listTemplateBlocks()
      setTemplates(t)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  const getSlotFromY = useCallback((y: number, dayCol: HTMLElement): number => {
    const rect = dayCol.getBoundingClientRect()
    const relY = y - rect.top
    const slot = Math.floor(relY / SLOT_PX)
    return Math.max(0, Math.min(slot, HOURS.length * SLOTS_PER_HOUR - 1))
  }, [])

  const slotToTime = (slot: number): string => {
    const totalMin = (HOUR_START * 60) + (slot * 15)
    return minutesToTime(totalMin)
  }

  const handlePointerDown = (e: React.PointerEvent, dayIndex: number) => {
    if ((e.target as HTMLElement).closest('.tmpl-grid-block')) return
    const dayCol = e.currentTarget as HTMLElement
    const slot = getSlotFromY(e.clientY, dayCol)
    setDragState({ dayIndex, startSlot: slot, currentSlot: slot })
    dayCol.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState) return
    const dayCol = e.currentTarget as HTMLElement
    const slot = getSlotFromY(e.clientY, dayCol)
    setDragState(prev => prev ? { ...prev, currentSlot: slot } : null)
  }

  const handlePointerUp = () => {
    if (!dragState) return
    const { dayIndex, startSlot, currentSlot } = dragState
    const minSlot = Math.min(startSlot, currentSlot)
    const maxSlot = Math.max(startSlot, currentSlot) + 1
    const startTime = slotToTime(minSlot)
    const endTime = slotToTime(maxSlot)

    setFormName('')
    setFormDays([dayIndex])
    setFormStart(startTime)
    setFormEnd(endTime)
    setFormCategory('personal')
    setFormColor('sky')
    setEditingBlock('new')
    setDragState(null)
  }

  const openForm = (block: TemplateBlockResponse | 'new') => {
    if (block === 'new') {
      setFormName('')
      setFormDays([0])
      setFormStart('09:00')
      setFormEnd('10:00')
      setFormCategory('personal')
      setFormColor('sky')
    } else {
      setFormName(block.name)
      setFormDays([block.day_of_week])
      setFormStart(block.start_time)
      setFormEnd(block.end_time)
      setFormCategory(block.category)
      setFormColor(block.color)
    }
    setEditingBlock(block)
  }

  const handleSave = async () => {
    if (!formName.trim() || formDays.length === 0) return
    if (editingBlock === 'new') {
      // Create one block per selected day
      for (const day of formDays) {
        const data: TemplateBlockCreate = {
          name: formName.trim(),
          day_of_week: day,
          start_time: formStart,
          end_time: formEnd,
          category: formCategory,
          color: formColor,
        }
        await createTemplateBlock(data)
      }
    } else if (editingBlock) {
      const data: TemplateBlockUpdate = {
        name: formName.trim(),
        day_of_week: formDays[0],
        start_time: formStart,
        end_time: formEnd,
        category: formCategory,
        color: formColor,
      }
      await updateTemplateBlock(editingBlock.id, data)
    }
    setEditingBlock(null)
    await loadTemplates()
  }

  const handleDelete = async (id: number) => {
    await deleteTemplateBlock(id)
    setEditingBlock(null)
    await loadTemplates()
  }

  const handleCategoryChange = (cat: string) => {
    setFormCategory(cat)
    if (editingBlock === 'new') {
      setFormColor(CATEGORY_COLOR[cat] || 'indigo')
    }
  }

  return (
    <div className="template-editor-overlay" onClick={onClose}>
      <div className="template-editor" onClick={e => e.stopPropagation()}>
        <div className="template-editor-header">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Week Template</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {loading ? '...' : `${templates.length} blocks — drag on grid to create`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <button className="schedule-toolbar-btn" onClick={() => openForm('new')}>+ Add Block</button>
            <button className="schedule-toolbar-btn" style={{ background: 'rgba(129,140,248,0.2)', color: 'var(--accent-indigo)' }} onClick={async () => { await onApply(); onClose() }}>
              Apply to This Week
            </button>
            <button className="block-popover-close" onClick={onClose}>x</button>
          </div>
        </div>

        <div className="tmpl-grid-container" ref={gridRef}>
          <div className="tmpl-grid">
            {/* Corner */}
            <div className="tmpl-grid-corner" />
            {/* Day headers */}
            {DAYS.map(day => (
              <div key={day} className="tmpl-grid-day-header">{day}</div>
            ))}

            {/* Hour labels */}
            {HOURS.map(hour => (
              <div key={hour} className="tmpl-grid-hour-label">{formatHour(hour)}</div>
            ))}

            {/* Day columns with blocks */}
            {DAYS.map((_, dayIndex) => {
              const dayBlocks = templates.filter(t => t.day_of_week === dayIndex)

              return (
                <div
                  key={dayIndex}
                  className="tmpl-grid-day-col"
                  style={{
                    gridColumn: dayIndex + 2,
                    gridRow: `2 / ${HOURS.length + 2}`,
                    position: 'relative',
                    height: HOURS.length * SLOT_HEIGHT,
                  }}
                  onPointerDown={(e) => handlePointerDown(e, dayIndex)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  {/* Hour lines */}
                  {HOURS.map((_, i) => (
                    <div
                      key={i}
                      className="tmpl-grid-hour-line"
                      style={{ top: i * SLOT_HEIGHT }}
                    />
                  ))}

                  {/* Drag preview */}
                  {dragState && dragState.dayIndex === dayIndex && (
                    <div
                      className="week-block-drag-preview"
                      style={{
                        top: Math.min(dragState.startSlot, dragState.currentSlot) * SLOT_PX,
                        height: (Math.abs(dragState.currentSlot - dragState.startSlot) + 1) * SLOT_PX,
                      }}
                    />
                  )}

                  {/* Template blocks */}
                  {dayBlocks.map(block => {
                    const startMin = timeToMinutes(block.start_time) - HOUR_START * 60
                    const endMin = timeToMinutes(block.end_time) - HOUR_START * 60
                    const blockTop = (startMin / 60) * SLOT_HEIGHT
                    const blockHeight = Math.max(((endMin - startMin) / 60) * SLOT_HEIGHT, SLOT_PX)
                    const color = COLOR_MAP[block.color] || 'var(--accent-indigo)'

                    return (
                      <div
                        key={block.id}
                        className="tmpl-grid-block"
                        style={{
                          top: blockTop,
                          height: blockHeight,
                          borderLeftColor: color,
                          background: `color-mix(in srgb, ${color} 15%, transparent)`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          openForm(block)
                        }}
                      >
                        <div className="tmpl-grid-block-name" style={{ color }}>{block.name}</div>
                        <div className="tmpl-grid-block-time">{block.start_time} - {block.end_time}</div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {editingBlock && (
          <div className="template-form">
            <div className="template-form-header">
              {editingBlock === 'new' ? 'New Template Block' : 'Edit Template Block'}
            </div>
            <div className="block-popover-body">
              <input
                className="block-popover-input"
                placeholder="Block name..."
                value={formName}
                onChange={e => setFormName(e.target.value)}
                autoFocus
              />
              <div className="block-popover-row">
                <label>Days</label>
                <div className="tmpl-day-picker">
                  {DAYS.map((d, i) => {
                    const selected = formDays.includes(i)
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`tmpl-day-chip ${selected ? 'active' : ''}`}
                        onClick={() => {
                          if (editingBlock !== 'new') {
                            // Single day when editing existing block
                            setFormDays([i])
                          } else {
                            setFormDays(prev =>
                              selected ? prev.filter(d => d !== i) : [...prev, i].sort()
                            )
                          }
                        }}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="block-popover-row block-popover-time-row">
                <div>
                  <label>Start</label>
                  <input type="time" value={formStart} onChange={e => setFormStart(e.target.value)} step="900" />
                </div>
                <div>
                  <label>End</label>
                  <input type="time" value={formEnd} onChange={e => setFormEnd(e.target.value)} step="900" />
                </div>
              </div>
              <div className="block-popover-row">
                <label>Category</label>
                <select value={formCategory} onChange={e => handleCategoryChange(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div className="block-popover-footer" style={{ border: 'none', padding: 0 }}>
                {editingBlock !== 'new' && (
                  <button className="block-popover-delete-btn" onClick={() => handleDelete((editingBlock as TemplateBlockResponse).id)}>Delete</button>
                )}
                <div style={{ flex: 1 }} />
                <button className="block-popover-cancel-btn" onClick={() => setEditingBlock(null)}>Cancel</button>
                <button className="block-popover-save-btn" onClick={handleSave}>Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
