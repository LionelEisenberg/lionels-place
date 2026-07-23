import { useState, useRef, useCallback } from 'react'
import type { TimeBlockResponse, TimeBlockCreate, TimeBlockUpdate } from '../../api'
import { toLocalISO } from '../../dates'
import BlockPopover from './BlockPopover'

interface WeekGridProps {
  weekStart: string
  blocks: TimeBlockResponse[]
  habitData: Record<string, Record<string, boolean>>
  onCreate: (data: TimeBlockCreate) => Promise<void>
  onUpdate: (id: number, data: TimeBlockUpdate) => Promise<void>
  onDelete: (id: number) => Promise<void>
}

const HOUR_START = 7
const HOUR_END = 21
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
const SLOT_HEIGHT = 60
const SLOTS_PER_HOUR = 4
const SLOT_PX = SLOT_HEIGHT / SLOTS_PER_HOUR

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

const HABIT_COLORS: Record<string, string> = {
  workout: '#34d399',
  productivity: '#818cf8',
  sleep: '#f59e0b',
  clean: '#38bdf8',
  love: '#ec4899',
  habit: '#8b5cf6',
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

function getWeekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday + 'T00:00:00')
    d.setDate(d.getDate() + i)
    return toLocalISO(d)
  })
}

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

export default function WeekGrid({ weekStart, blocks, habitData, onCreate, onUpdate, onDelete }: WeekGridProps) {
  const dates = getWeekDates(weekStart)
  const today = toLocalISO(new Date())
  const gridRef = useRef<HTMLDivElement>(null)

  const [popover, setPopover] = useState<{
    block?: TimeBlockResponse
    date?: string
    startTime?: string
    endTime?: string
    x: number
    y: number
  } | null>(null)

  const [dragState, setDragState] = useState<{
    dayIndex: number
    startSlot: number
    currentSlot: number
  } | null>(null)

  const DRAG_THRESHOLD = 4

  const [moveState, setMoveState] = useState<{
    blockId: number
    startY: number
    startX: number
    originalDate: string
    originalStartTime: string
    originalEndTime: string
    durationSlots: number
    offsetSlots: number
    currentDayIndex: number
    currentStartSlot: number
    isDragging: boolean
  } | null>(null)

  const [resizeState, setResizeState] = useState<{
    blockId: number
    startY: number
    originalEndTime: string
    currentEndSlot: number
    isDragging: boolean
  } | null>(null)

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
    if ((e.target as HTMLElement).closest('.week-block')) return
    const dayCol = (e.currentTarget as HTMLElement)
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

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragState) return
    const { dayIndex, startSlot, currentSlot } = dragState
    const minSlot = Math.min(startSlot, currentSlot)
    const maxSlot = Math.max(startSlot, currentSlot) + 1
    const startTime = slotToTime(minSlot)
    const endTime = slotToTime(maxSlot)

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPopover({
      date: dates[dayIndex],
      startTime,
      endTime,
      x: rect.left + rect.width / 2,
      y: rect.top + minSlot * SLOT_PX,
    })

    setDragState(null)
  }

  const effectiveStatus = (b: TimeBlockResponse) => b.auto_status || b.status

  return (
    <div className="week-grid-container" ref={gridRef}>
      {popover && <div className="popover-backdrop" onClick={() => setPopover(null)} />}

      {popover && (
        <BlockPopover
          block={popover.block}
          defaultDate={popover.date}
          defaultStartTime={popover.startTime}
          defaultEndTime={popover.endTime}
          position={{ x: popover.x, y: popover.y }}
          onSave={async (data) => {
            if (popover.block) {
              await onUpdate(popover.block.id, data)
            } else {
              await onCreate(data as TimeBlockCreate)
            }
            setPopover(null)
          }}
          onDelete={popover.block ? async () => {
            await onDelete(popover.block!.id)
            setPopover(null)
          } : undefined}
          onClose={() => setPopover(null)}
        />
      )}

      <div className="week-grid">
        <div className="week-grid-corner" />
        {dates.map((date, i) => {
          const d = new Date(date + 'T00:00:00')
          const isToday = date === today
          return (
            <div key={date} className={`week-grid-day-header ${isToday ? 'today' : ''}`}>
              <div className="week-grid-day-abbr">{DAYS[i]}</div>
              <div className="week-grid-day-num">{d.getDate()}</div>
              {habitData?.[date] && (
                <div className="week-grid-habit-dots">
                  {Object.entries(habitData[date])
                    .filter(([_, done]) => done)
                    .map(([habit]) => (
                      <span
                        key={habit}
                        className="week-grid-habit-dot"
                        style={{ background: HABIT_COLORS[habit] || 'var(--text-muted)' }}
                        title={habit}
                      />
                    ))}
                </div>
              )}
            </div>
          )
        })}

        {HOURS.map(hour => (
          <div key={hour} className="week-grid-hour-label">{formatHour(hour)}</div>
        ))}

        {dates.map((date, dayIndex) => {
          const isToday = date === today
          const dayBlocks = blocks.filter(b => b.date === date)

          return (
            <div
              key={date}
              className={`week-grid-day-col ${isToday ? 'today' : ''}`}
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
              {HOURS.map((_, i) => (
                <div
                  key={i}
                  className="week-grid-hour-line"
                  style={{ top: i * SLOT_HEIGHT }}
                />
              ))}

              {dragState && dragState.dayIndex === dayIndex && (
                <div
                  className="week-block-drag-preview"
                  style={{
                    top: Math.min(dragState.startSlot, dragState.currentSlot) * SLOT_PX,
                    height: (Math.abs(dragState.currentSlot - dragState.startSlot) + 1) * SLOT_PX,
                  }}
                />
              )}

              {dayBlocks.map(block => {
                const startMin = timeToMinutes(block.start_time) - HOUR_START * 60
                const endMin = timeToMinutes(block.end_time) - HOUR_START * 60
                const blockTop = (startMin / 60) * SLOT_HEIGHT
                const blockHeight = ((endMin - startMin) / 60) * SLOT_HEIGHT
                const color = COLOR_MAP[block.color] || 'var(--accent-indigo)'
                const status = effectiveStatus(block)

                // Override position during active move
                const isMoving = moveState?.blockId === block.id && moveState.isDragging
                const isResizing = resizeState?.blockId === block.id && resizeState.isDragging
                const displayTop = isMoving ? moveState!.currentStartSlot * SLOT_PX : blockTop
                const displayHeight = isResizing
                  ? (resizeState!.currentEndSlot * SLOT_PX) - blockTop
                  : Math.max(blockHeight, SLOT_PX)

                return (
                  <div
                    key={block.id}
                    className={`week-block week-block-${status}`}
                    style={{
                      top: displayTop,
                      height: displayHeight,
                      borderLeftColor: color,
                      background: `color-mix(in srgb, ${color} 15%, transparent)`,
                      opacity: isMoving ? 0.7 : 1,
                      zIndex: isMoving || isResizing ? 10 : 1,
                    }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest('.week-block-resize-handle')) return
                      e.stopPropagation()
                      e.preventDefault()
                      const dayCol = (e.currentTarget as HTMLElement).parentElement!
                      const clickSlot = getSlotFromY(e.clientY, dayCol)
                      const blockStartSlot = Math.floor(startMin / 15)
                      const durationSlots = Math.floor((endMin - startMin) / 15)

                      setMoveState({
                        blockId: block.id,
                        startY: e.clientY,
                        startX: e.clientX,
                        originalDate: block.date,
                        originalStartTime: block.start_time,
                        originalEndTime: block.end_time,
                        durationSlots,
                        offsetSlots: clickSlot - blockStartSlot,
                        currentDayIndex: dayIndex,
                        currentStartSlot: blockStartSlot,
                        isDragging: false,
                      })
                      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                    }}
                    onPointerMove={(e) => {
                      if (!moveState || moveState.blockId !== block.id) return
                      const dx = e.clientX - moveState.startX
                      const dy = e.clientY - moveState.startY
                      const dist = Math.sqrt(dx * dx + dy * dy)

                      if (!moveState.isDragging && dist < DRAG_THRESHOLD) return

                      const gridEl = gridRef.current
                      if (!gridEl) return
                      const dayCols = gridEl.querySelectorAll('.week-grid-day-col')
                      let newDayIndex = moveState.currentDayIndex
                      for (let i = 0; i < dayCols.length; i++) {
                        const rect = dayCols[i].getBoundingClientRect()
                        if (e.clientX >= rect.left && e.clientX < rect.right) {
                          newDayIndex = i
                          break
                        }
                      }

                      const dayCol = dayCols[newDayIndex] as HTMLElement
                      const slot = getSlotFromY(e.clientY, dayCol)
                      const newStartSlot = Math.max(0, slot - moveState.offsetSlots)

                      setMoveState(prev => prev ? {
                        ...prev,
                        isDragging: true,
                        currentDayIndex: newDayIndex,
                        currentStartSlot: newStartSlot,
                      } : null)
                    }}
                    onPointerUp={async (e) => {
                      if (!moveState || moveState.blockId !== block.id) return

                      if (!moveState.isDragging) {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setPopover({ block, x: rect.right + 8, y: rect.top })
                        setMoveState(null)
                        return
                      }

                      const newStartTime = slotToTime(moveState.currentStartSlot)
                      const durationMin = timeToMinutes(moveState.originalEndTime) - timeToMinutes(moveState.originalStartTime)
                      const newEndTime = minutesToTime(HOUR_START * 60 + moveState.currentStartSlot * 15 + durationMin)
                      const newDate = dates[moveState.currentDayIndex]

                      setMoveState(null)
                      await onUpdate(block.id, {
                        date: newDate,
                        start_time: newStartTime,
                        end_time: newEndTime,
                      })
                    }}
                  >
                    <div className="week-block-name" style={{ color }}>{block.name}</div>
                    <div className="week-block-time">
                      {block.start_time} – {block.end_time}
                    </div>
                    {block.task_title && (
                      <div className="week-block-task">📋 {block.task_title}</div>
                    )}
                    <div className={`week-block-status week-block-status-${status}`}>
                      {status === 'done' && (
                        <span>✓ {block.auto_status ? `auto: ${block.auto_detail}` : 'done'}</span>
                      )}
                      {status === 'skipped' && <span>✗ skipped</span>}
                      {status === 'planned' && <span>○ planned</span>}
                    </div>
                    <div
                      className="week-block-resize-handle"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        setResizeState({
                          blockId: block.id,
                          startY: e.clientY,
                          originalEndTime: block.end_time,
                          currentEndSlot: Math.floor((timeToMinutes(block.end_time) - HOUR_START * 60) / 15),
                          isDragging: false,
                        })
                        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                      }}
                      onPointerMove={(e) => {
                        if (!resizeState || resizeState.blockId !== block.id) return
                        const dayCol = (e.currentTarget as HTMLElement).closest('.week-grid-day-col') as HTMLElement
                        if (!dayCol) return
                        const slot = getSlotFromY(e.clientY, dayCol)
                        const blockStartSlot = Math.floor(startMin / 15)
                        const newEndSlot = Math.max(blockStartSlot + 1, slot + 1)

                        setResizeState(prev => prev ? {
                          ...prev,
                          isDragging: true,
                          currentEndSlot: newEndSlot,
                        } : null)
                      }}
                      onPointerUp={async () => {
                        if (!resizeState || resizeState.blockId !== block.id) return
                        if (!resizeState.isDragging) {
                          setResizeState(null)
                          return
                        }
                        const newEndTime = slotToTime(resizeState.currentEndSlot)
                        setResizeState(null)
                        await onUpdate(block.id, { end_time: newEndTime })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
