import { useState, useEffect, useRef, useCallback } from 'react'
import {
  DndContext, pointerWithin, rectIntersection, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent, DragOverlay, useDroppable,
  type CollisionDetection,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  listTasks, createTask, updateTask, deleteTask, moveTask,
  taskChatAsync,
  type TaskResponse, type TaskCreate, type TaskUpdate,
} from '../../api'
import { useContextJobs } from '../../useContextJobs'

// ==========================================
// Category color assignment
// ==========================================
const CATEGORY_COLORS = [
  'var(--accent-indigo)', 'var(--accent-emerald)', 'var(--accent-amber)',
  'var(--accent-rose)', 'var(--accent-sky)', 'var(--accent-orange)',
]
function categoryColor(cat: string): string {
  let hash = 0
  for (let i = 0; i < cat.length; i++) hash = cat.charCodeAt(i) + ((hash << 5) - hash)
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length]
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'var(--accent-rose)',
  medium: 'var(--accent-amber)',
  low: 'var(--accent-sky)',
}

const COLUMN_IDS = new Set(['todo', 'in_progress', 'done'])

// Custom collision: prefer sortable card hits (pointerWithin), fall back to column droppable (rectIntersection)
// Always filter out the active (dragged) item so it can't match itself
const kanbanCollision: CollisionDetection = (args) => {
  const activeId = args.active.id

  // First check pointer-within — finds cards/columns the pointer is inside
  const pointerHits = pointerWithin(args).filter(h => h.id !== activeId)
  const cardHits = pointerHits.filter(h => !COLUMN_IDS.has(h.id as string))
  if (cardHits.length > 0) return cardHits

  // No card hit — check if pointer is within a column
  const columnHits = pointerHits.filter(h => COLUMN_IDS.has(h.id as string))
  if (columnHits.length > 0) return columnHits

  // Fall back to rect intersection for edge cases
  const rectHits = rectIntersection(args).filter(h => h.id !== activeId)
  const rectColumnHits = rectHits.filter(h => COLUMN_IDS.has(h.id as string))
  if (rectColumnHits.length > 0) return rectColumnHits

  return rectHits
}

type ColumnStatus = 'todo' | 'in_progress' | 'done'
const COLUMNS: { status: ColumnStatus; label: string }[] = [
  { status: 'todo', label: 'To Do' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'done', label: 'Done' },
]

// ==========================================
// Sortable Task Card
// ==========================================
function TaskCard({ task, onClick, isDragging }: {
  task: TaskResponse
  onClick: () => void
  isDragging?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: task.id.toString(),
    data: { task },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const isOverdue = task.due_date && task.due_date < new Date().toISOString().slice(0, 10) && task.status !== 'done'

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="task-card"
      onClick={onClick}
    >
      <div className="task-card-header">
        <span className="task-category-chip" style={{ background: categoryColor(task.category), color: '#fff' }}>
          {task.category}
        </span>
        {task.priority && (
          <span className="task-priority-badge" style={{ color: PRIORITY_COLORS[task.priority] }}>
            {task.priority[0].toUpperCase()}
          </span>
        )}
      </div>
      <div className="task-card-title">{task.title}</div>
      {task.due_date && (
        <div className="task-due-date" style={isOverdue ? { color: 'var(--accent-rose)' } : {}}>
          {isOverdue ? '⚠ ' : ''}{task.due_date}
        </div>
      )}
      {task.notes && (
        <div className="task-card-notes">{task.notes}</div>
      )}
    </div>
  )
}

// ==========================================
// Droppable Column
// ==========================================
function KanbanColumn({ status, label, tasks, onCardClick, isCollapsed, onToggleCollapse }: {
  status: ColumnStatus
  label: string
  tasks: TaskResponse[]
  onCardClick: (task: TaskResponse) => void
  isCollapsed?: boolean
  onToggleCollapse?: () => void
}) {
  const sortableIds = tasks.map(t => t.id.toString())
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: status })

  return (
    <div className="kanban-column" data-status={status}>
      <div className="kanban-column-header" onClick={onToggleCollapse}>
        <span>{label}</span>
        <span className="kanban-column-count">{tasks.length}</span>
        {status === 'done' && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {isCollapsed ? '▸' : '▾'}
          </span>
        )}
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setDropRef}
          className={`kanban-column-body${isOver ? ' drop-target' : ''}`}
          data-status={status}
          style={status === 'done' && isCollapsed ? { minHeight: '40px', opacity: 0.5 } : undefined}
        >
          {!(status === 'done' && isCollapsed) && (
            <>
              {tasks.map(task => (
                <TaskCard key={task.id} task={task} onClick={() => onCardClick(task)} />
              ))}
              {tasks.length === 0 && (
                <div className="kanban-empty">No tasks</div>
              )}
            </>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

// ==========================================
// Task Modal (create/edit)
// ==========================================
function TaskModal({ task, categories, onSave, onDelete, onClose }: {
  task: TaskResponse | 'new'
  categories: string[]
  onSave: (data: TaskCreate | TaskUpdate, id?: number) => void
  onDelete?: (id: number) => void
  onClose: () => void
}) {
  const isNew = task === 'new'
  const [title, setTitle] = useState(isNew ? '' : task.title)
  const [category, setCategory] = useState(isNew ? 'Personal' : task.category)
  const [priority, setPriority] = useState<string>(isNew ? '' : (task.priority || ''))
  const [dueDate, setDueDate] = useState(isNew ? '' : (task.due_date || ''))
  const [notes, setNotes] = useState(isNew ? '' : (task.notes || ''))
  const [status, setStatus] = useState(isNew ? 'todo' : task.status)

  const handleSave = () => {
    if (!title.trim()) return
    if (isNew) {
      onSave({
        title: title.trim(),
        category,
        status,
        priority: priority || undefined,
        due_date: dueDate || undefined,
        notes: notes || undefined,
      } as TaskCreate)
    } else {
      onSave({
        title: title.trim(),
        category,
        priority: priority || null,
        due_date: dueDate || null,
        notes: notes || null,
      } as TaskUpdate, task.id)
    }
  }

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 'var(--space-md)' }}>{isNew ? 'New Task' : 'Edit Task'}</h3>

        <label className="task-modal-label">Title</label>
        <input
          className="task-modal-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
          <div>
            <label className="task-modal-label">Category</label>
            <input
              className="task-modal-input"
              value={category}
              onChange={e => setCategory(e.target.value)}
              list="task-categories-list"
            />
            <datalist id="task-categories-list">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div>
            <label className="task-modal-label">Priority</label>
            <select className="task-modal-input" value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="">None</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
          <div>
            <label className="task-modal-label">Due Date</label>
            <input
              className="task-modal-input"
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
            />
          </div>
          {isNew && (
            <div>
              <label className="task-modal-label">Status</label>
              <select className="task-modal-input" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
              </select>
            </div>
          )}
        </div>

        <label className="task-modal-label">Notes</label>
        <textarea
          className="task-modal-input"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          placeholder="Additional details..."
        />

        <div style={{ display: 'flex', gap: 'var(--space-sm)', justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
          {!isNew && onDelete && (
            <button className="btn btn-ghost" style={{ color: 'var(--accent-rose)', marginRight: 'auto' }}
              onClick={() => { if (confirm('Delete this task?')) onDelete(task.id) }}>
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!title.trim()}>
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ==========================================
// Main Tasks Page
// ==========================================
export default function Tasks() {
  const [tasks, setTasks] = useState<TaskResponse[]>([])
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [modalTask, setModalTask] = useState<TaskResponse | 'new' | null>(null)
  const [doneCollapsed, setDoneCollapsed] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Advisor state
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  const dragOccurredRef = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  const categories = [...new Set(tasks.map(t => t.category))].sort()

  const loadTasks = useCallback(async () => {
    try {
      const t = await listTasks()
      setTasks(t)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadTasks() }, [loadTasks])

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [chatMessages])

  // Filter tasks
  const visibleTasks = activeFilters.length === 0
    ? tasks
    : tasks.filter(t => activeFilters.includes(t.category))

  const tasksByColumn = (status: ColumnStatus) =>
    visibleTasks.filter(t => t.status === status).sort((a, b) => a.position - b.position)

  // Compute drop position
  function computeDropPosition(columnTasks: TaskResponse[], overIndex: number): number {
    if (columnTasks.length === 0) return 1000.0
    if (overIndex <= 0) return columnTasks[0].position / 2
    if (overIndex >= columnTasks.length) return columnTasks[columnTasks.length - 1].position + 1000.0
    return (columnTasks[overIndex - 1].position + columnTasks[overIndex].position) / 2
  }

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id.toString())
    dragOccurredRef.current = true
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null)
    setTimeout(() => { dragOccurredRef.current = false }, 0)
    const { active, over } = event
    if (!over) return

    const draggedTask = tasks.find(t => t.id.toString() === active.id.toString())
    if (!draggedTask) return

    // Determine target status
    let targetStatus: ColumnStatus = draggedTask.status as ColumnStatus
    let overTask: TaskResponse | undefined

    // Check if dropped on a task (exclude self)
    const overCandidate = tasks.find(t => t.id.toString() === over.id.toString())
    if (overCandidate && overCandidate.id !== draggedTask.id) {
      overTask = overCandidate
      targetStatus = overTask.status as ColumnStatus
    } else if (COLUMN_IDS.has(over.id as string)) {
      targetStatus = over.id as ColumnStatus
    }

    // Get column tasks (excluding dragged)
    const columnTasks = tasks
      .filter(t => t.status === targetStatus && t.id !== draggedTask.id)
      .sort((a, b) => a.position - b.position)

    let newPosition: number
    if (overTask && overTask.id !== draggedTask.id) {
      const overIndex = columnTasks.findIndex(t => t.id === overTask!.id)
      newPosition = computeDropPosition(columnTasks, overIndex)
    } else {
      newPosition = columnTasks.length > 0
        ? columnTasks[columnTasks.length - 1].position + 1000.0
        : 1000.0
    }

    // Optimistic update
    const origStatus = draggedTask.status
    const origPosition = draggedTask.position
    setTasks(ts => ts.map(t =>
      t.id === draggedTask.id
        ? { ...t, status: targetStatus, position: newPosition }
        : t
    ))

    try {
      await moveTask(draggedTask.id, { status: targetStatus, position: newPosition })
    } catch {
      setTasks(ts => ts.map(t =>
        t.id === draggedTask.id ? { ...t, status: origStatus, position: origPosition } : t
      ))
    }
  }

  // CRUD handlers
  const handleSave = async (data: TaskCreate | TaskUpdate, id?: number) => {
    try {
      if (id) {
        await updateTask(id, data as TaskUpdate)
      } else {
        await createTask(data as TaskCreate)
      }
      await loadTasks()
    } catch { /* ignore */ }
    setModalTask(null)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteTask(id)
      await loadTasks()
    } catch { /* ignore */ }
    setModalTask(null)
  }

  // Category filter toggle
  const toggleFilter = (cat: string) => {
    setActiveFilters(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    )
  }

  // Advisor chat — routed through the llm_jobs queue; [CREATE_TASK] markers are
  // applied server-side by the tasks_chat result-hook, so we just refetch tasks.
  const { submit: submitChat } = useContextJobs<{ response: string }>('tasks_chat', {
    transform: (raw) => ({ response: (raw.response as string) ?? '' }),
    onResult: (res) => {
      setChatMessages(prev => [...prev, { role: 'assistant', content: res.response }])
      setChatLoading(false)
      loadTasks()
    },
    onError: (err) => {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err}` }])
      setChatLoading(false)
    },
  })

  const handleAdvisorSend = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = chatInput.trim()
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }])
    setChatLoading(true)
    submitChat(() => taskChatAsync(userMsg))
  }

  const activeTask = activeId ? tasks.find(t => t.id.toString() === activeId) : null

  if (loading) {
    return <div className="loading-overlay"><span className="loading-spinner" /></div>
  }

  return (
    <div className="tasks-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <h1>Tasks</h1>
        <button className="btn btn-primary" onClick={() => setModalTask('new')} style={{ fontSize: '0.85rem' }}>
          + New Task
        </button>
      </div>

      {/* Category filters */}
      {categories.length > 0 && (
        <div className="kanban-toolbar">
          {categories.map(cat => (
            <button
              key={cat}
              className={`category-filter-chip${activeFilters.includes(cat) ? ' active' : ''}`}
              style={{ '--chip-color': categoryColor(cat) } as React.CSSProperties}
              onClick={() => toggleFilter(cat)}
            >
              {cat}
            </button>
          ))}
          {activeFilters.length > 0 && (
            <button className="category-filter-chip clear" onClick={() => setActiveFilters([])}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* Kanban Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={kanbanCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="kanban-board">
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.status}
              status={col.status}
              label={col.label}
              tasks={tasksByColumn(col.status)}
              onCardClick={task => { if (!dragOccurredRef.current) setModalTask(task) }}
              isCollapsed={col.status === 'done' ? doneCollapsed : false}
              onToggleCollapse={col.status === 'done' ? () => setDoneCollapsed(c => !c) : undefined}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="task-card dragging-overlay">
              <div className="task-card-header">
                <span className="task-category-chip" style={{ background: categoryColor(activeTask.category), color: '#fff' }}>
                  {activeTask.category}
                </span>
              </div>
              <div className="task-card-title">{activeTask.title}</div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* AI Advisor */}
      <div className="advisor-section" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="advisor-header" onClick={() => setAdvisorOpen(o => !o)}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            🤖 Task Advisor {advisorOpen ? '▾' : '▸'}
          </span>
        </div>

        {advisorOpen && (
          <>
            <div className="chat-messages" ref={chatScrollRef} style={{ padding: 'var(--space-md)', maxHeight: '420px' }}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-lg)' }}>
                  Ask me to create tasks, prioritize your day, or check what's overdue.
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`chat-bubble ${msg.role}`}>
                  {msg.content}
                </div>
              ))}
              {chatLoading && (
                <div className="loading-overlay">
                  <span className="loading-spinner" /> Thinking...
                </div>
              )}
            </div>
            <div className="advisor-input-row">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="e.g. 'Add task: update resume by Friday' or 'what should I focus on?'"
                style={{
                  flex: 1,
                  padding: 'var(--space-sm) var(--space-md)',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-medium)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '0.9rem',
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleAdvisorSend() }}
              />
              <button className="btn btn-primary" onClick={handleAdvisorSend} disabled={chatLoading}
                style={{ fontSize: '0.85rem', padding: '6px 16px' }}>
                Send
              </button>
            </div>
          </>
        )}
      </div>

      {/* Task Modal */}
      {modalTask && (
        <TaskModal
          task={modalTask}
          categories={categories.length > 0 ? categories : ['Personal', 'Job Search', 'Health', 'Social']}
          onSave={handleSave}
          onDelete={modalTask !== 'new' ? handleDelete : undefined}
          onClose={() => setModalTask(null)}
        />
      )}
    </div>
  )
}
