/**
 * MealLog — date-grouped meal browser with summary stats, filters, and inline editing.
 */

import { useState, useEffect, useMemo } from 'react'
import {
  listMeals, updateMeal, updateMealItems, deleteMeal, duplicateMeal, mealStats,
  type MealResponse, type MealStats, type MealItemData,
} from '../api'
import { todayISO, startOfWeekISO, startOfMonthISO, friendlyDate, weekdayName } from '../dates'
import QuickAddPanel from '../components/QuickAddPanel'

type DateRange = 'today' | 'week' | 'month' | 'all'
const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const

const EMPTY_ITEM: MealItemData = {
  name: '', quantity: '', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
}

export default function MealLog() {
  // Data
  const [meals, setMeals] = useState<MealResponse[]>([])
  const [stats, setStats] = useState<MealStats | null>(null)
  const [loading, setLoading] = useState(true)

  // Filters
  const [dateRange, setDateRange] = useState<DateRange>('week')
  const [mealTypes, setMealTypes] = useState<Set<string> | null>(null)
  const [search, setSearch] = useState('')

  // Edit state (meal-level)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editData, setEditData] = useState<Partial<MealResponse>>({})
  const [isAdding, setIsAdding] = useState(false)

  // Edit state (item-level)
  const [editingItemsId, setEditingItemsId] = useState<number | null>(null)
  const [itemDrafts, setItemDrafts] = useState<MealItemData[]>([])

  // Collapse state
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Expanded meal items
  const [expandedMeals, setExpandedMeals] = useState<Set<number>>(new Set())

  // Compute date bounds from range
  const dateBounds = useMemo(() => {
    const end = todayISO()
    switch (dateRange) {
      case 'today': return { start: end, end }
      case 'week': return { start: startOfWeekISO(), end }
      case 'month': return { start: startOfMonthISO(), end }
      case 'all': return { start: undefined, end: undefined }
    }
  }, [dateRange])

  // Load meals
  const load = async () => {
    setLoading(true)
    try {
      const [mealData, statsData] = await Promise.all([
        listMeals(dateBounds.start, dateBounds.end, 1000),
        mealStats(dateBounds.start, dateBounds.end),
      ])
      setMeals(mealData)
      setStats(statsData)
    } catch (err) {
      console.error('Failed to load meals:', err)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [dateBounds.start, dateBounds.end])

  // Filter + group meals
  const filteredMeals = useMemo(() => {
    return meals.filter(m => {
      if (mealTypes && !mealTypes.has(m.meal)) return false
      if (search && !m.description.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [meals, mealTypes, search])

  const groupedByDate = useMemo(() => {
    const groups = new Map<string, MealResponse[]>()
    for (const m of filteredMeals) {
      const existing = groups.get(m.date) || []
      existing.push(m)
      groups.set(m.date, existing)
    }
    return groups
  }, [filteredMeals])

  // Helpers
  const getMealClass = (meal: string) => {
    const m = meal?.toLowerCase() || ''
    if (m.includes('breakfast')) return 'breakfast'
    if (m.includes('lunch')) return 'lunch'
    if (m.includes('dinner')) return 'dinner'
    if (m.includes('snack')) return 'snack'
    return 'default'
  }

  const toggleCollapse = (date: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(date) ? next.delete(date) : next.add(date)
      return next
    })
  }

  const toggleMealExpand = (id: number) => {
    // Close item editing if we're collapsing
    if (expandedMeals.has(id) && editingItemsId === id) {
      setEditingItemsId(null)
      setItemDrafts([])
    }
    setExpandedMeals(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleMealType = (type: string) => {
    setMealTypes(prev => {
      if (prev === null) {
        return new Set([type])
      }
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      return next.size === 0 ? null : next
    })
  }

  // CRUD — meal-level
  const startEdit = (meal: MealResponse) => {
    setIsAdding(false)
    setEditingItemsId(null)
    setEditingId(meal.id)
    const { items, ...rest } = meal
    setEditData({ ...rest })
  }

  const startAdd = () => {
    setEditingId(null)
    setEditingItemsId(null)
    setEditData({
      date: todayISO(), meal: '', description: '',
      calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
    })
    setIsAdding(true)
  }

  const saveEdit = async () => {
    if (isAdding) {
      try {
        const token = localStorage.getItem('auth_token') || ''
        await fetch('/helm/api/meals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify([editData]),
        })
        setIsAdding(false)
        setEditData({})
        await load()
      } catch (err) { console.error('Failed to create meal:', err) }
    } else {
      if (editingId === null) return
      try {
        await updateMeal(editingId, editData)
        setEditingId(null)
        setEditData({})
        await load()
      } catch (err) { console.error('Failed to update meal:', err) }
    }
  }

  const cancelEdit = () => {
    setEditingId(null)
    setIsAdding(false)
    setEditData({})
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this meal?')) return
    try { await deleteMeal(id); await load() }
    catch (err) { console.error('Failed to delete meal:', err) }
  }

  const handleDuplicate = async (id: number) => {
    try { await duplicateMeal(id); await load() }
    catch (err) { console.error('Failed to duplicate meal:', err) }
  }

  // CRUD — item-level
  const startItemEdit = (meal: MealResponse) => {
    setEditingId(null)
    setEditingItemsId(meal.id)
    setItemDrafts((meal.items || []).map(i => ({ ...i })))
  }

  const cancelItemEdit = () => {
    setEditingItemsId(null)
    setItemDrafts([])
  }

  const updateItemDraft = (idx: number, field: keyof MealItemData, value: string | number) => {
    setItemDrafts(prev => prev.map((item, i) =>
      i === idx ? { ...item, [field]: value } : item
    ))
  }

  const removeItemDraft = (idx: number) => {
    setItemDrafts(prev => prev.filter((_, i) => i !== idx))
  }

  const addItemDraft = () => {
    setItemDrafts(prev => [...prev, { ...EMPTY_ITEM }])
  }

  const saveItemEdits = async () => {
    if (editingItemsId === null) return
    try {
      await updateMealItems(editingItemsId, itemDrafts)
      setEditingItemsId(null)
      setItemDrafts([])
      await load()
    } catch (err) { console.error('Failed to update meal items:', err) }
  }



  const EditField = ({ field, type = 'text', options }: { field: Exclude<keyof MealResponse, 'items'>; type?: string; options?: string[] }) => {
    const value = editData[field] ?? ''
    const handleChange = (val: any) => setEditData(prev => ({ ...prev, [field]: val }))

    if (type === 'select' && options) {
      return (
        <select value={value as string} onChange={e => handleChange(e.target.value)}>
          <option value="">Select...</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (type === 'textarea') {
      return (
        <textarea
          value={value as string}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') cancelEdit()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
          }}
        />
      )
    }
    return (
      <input
        type={type}
        value={value}
        onChange={e => handleChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') saveEdit()
          if (e.key === 'Escape') cancelEdit()
        }}
      />
    )
  }

  const EditRow = () => (
    <div className="meal-edit-row">
      <div className="meal-edit-top">
        <EditField field="date" type="date" />
        <EditField field="meal" type="select" options={[...MEAL_TYPES]} />
        <div className="meal-edit-desc-wrap"><EditField field="description" type="textarea" /></div>
      </div>
      <div className="meal-edit-bottom">
        <label className="meal-edit-macro-field">
          <span style={{ color: 'var(--color-protein)' }}>P</span>
          <EditField field="protein_g" type="number" />
        </label>
        <label className="meal-edit-macro-field">
          <span style={{ color: 'var(--color-carbs)' }}>C</span>
          <EditField field="carbs_g" type="number" />
        </label>
        <label className="meal-edit-macro-field">
          <span style={{ color: 'var(--color-fat)' }}>F</span>
          <EditField field="fat_g" type="number" />
        </label>
        <label className="meal-edit-macro-field">
          <span style={{ color: 'var(--color-fiber)' }}>Fb</span>
          <EditField field="fiber_g" type="number" />
        </label>
        <label className="meal-edit-macro-field">
          <span style={{ color: 'var(--color-calories)' }}>Cal</span>
          <EditField field="calories" type="number" />
        </label>
        <div className="meal-edit-btns">
          <button className="action-btn save-btn" onClick={saveEdit} title="Save">✓</button>
          <button className="action-btn cancel-btn" onClick={cancelEdit} title="Cancel">✕</button>
        </div>
      </div>
    </div>
  )

  const today = todayISO()

  return (
    <>
      {/* Page Header */}
      <div className="page-header" style={{ marginBottom: 'var(--space-md)' }}>
        <div>
          <h1>🍽️ Meal Log</h1>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {filteredMeals.length} entries
          </span>
        </div>
        <button className="btn btn-primary" onClick={startAdd} disabled={isAdding}>
          + Add Meal
        </button>
      </div>

      {/* Quick Add Panel */}
      <QuickAddPanel onLogged={load} />

      {/* Summary Strip */}
      {stats && (
        <div className="meal-summary-strip">
          <div className="meal-summary-card" style={{ '--card-accent': 'var(--color-calories)', '--card-glow': 'rgba(245,158,11,0.1)' } as React.CSSProperties}>
            <div className="meal-summary-label">Avg Daily Calories</div>
            <div className="meal-summary-value">{stats.avg_calories.toLocaleString()}<span className="unit">cal</span></div>
          </div>
          <div className="meal-summary-card" style={{ '--card-accent': 'var(--color-protein)', '--card-glow': 'rgba(99,102,241,0.1)' } as React.CSSProperties}>
            <div className="meal-summary-label">Avg Protein</div>
            <div className="meal-summary-value">{stats.avg_protein}<span className="unit">g</span></div>
          </div>
          <div className="meal-summary-card" style={{ '--card-accent': 'var(--color-carbs)', '--card-glow': 'rgba(56,189,248,0.1)' } as React.CSSProperties}>
            <div className="meal-summary-label">Avg Carbs</div>
            <div className="meal-summary-value">{stats.avg_carbs}<span className="unit">g</span></div>
          </div>
          <div className="meal-summary-card" style={{ '--card-accent': 'var(--color-fat)', '--card-glow': 'rgba(244,63,94,0.1)' } as React.CSSProperties}>
            <div className="meal-summary-label">Avg Fat</div>
            <div className="meal-summary-value">{stats.avg_fat}<span className="unit">g</span></div>
          </div>
          <div className="meal-summary-card" style={{ '--card-accent': 'var(--color-fiber)', '--card-glow': 'rgba(16,185,129,0.1)' } as React.CSSProperties}>
            <div className="meal-summary-label">Meals Logged</div>
            <div className="meal-summary-value">{stats.meal_count}</div>
            <div className="meal-summary-sub">{stats.meals_per_day} meals/day avg</div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="meal-filter-bar">
        <div className="meal-filter-group">
          {(['today', 'week', 'month', 'all'] as DateRange[]).map(r => (
            <button
              key={r}
              className={`meal-filter-chip${dateRange === r ? ' active' : ''}`}
              onClick={() => setDateRange(r)}
            >
              {r === 'today' ? 'Today' : r === 'week' ? 'This Week' : r === 'month' ? 'This Month' : 'All'}
            </button>
          ))}
        </div>

        <div className="meal-filter-divider" />

        {MEAL_TYPES.map(type => (
          <button
            key={type}
            className={`meal-type-filter ${getMealClass(type)}${mealTypes === null || mealTypes.has(type) ? ' active' : ''}`}
            onClick={() => toggleMealType(type)}
          >
            {type}
          </button>
        ))}

        <div className="meal-search-box">
          <span className="meal-search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search meals..."
            value={search}
            onChange={e => { setSearch(e.target.value); if (e.target.value.trim()) setDateRange('all'); }}
          />
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="loading-overlay"><span className="loading-spinner" /> Loading meals...</div>
      ) : (
        <>
          {/* Add row (pinned at top) */}
          {isAdding && <div style={{ marginBottom: 6 }}><EditRow /></div>}

          {/* Day groups */}
          {Array.from(groupedByDate.entries()).map(([date, dayMeals]) => {
            const dayCal = dayMeals.reduce((s, m) => s + m.calories, 0)
            const dayPro = dayMeals.reduce((s, m) => s + m.protein_g, 0)
            const dayCarb = dayMeals.reduce((s, m) => s + m.carbs_g, 0)
            const dayFat = dayMeals.reduce((s, m) => s + m.fat_g, 0)
            const dayFiber = dayMeals.reduce((s, m) => s + m.fiber_g, 0)
            const macroTotal = dayPro + dayCarb + dayFat || 1
            const isCollapsed = collapsed.has(date)

            return (
              <div className="meal-day-group" key={date}>
                {/* Day Header */}
                <div
                  className={`meal-day-header${isCollapsed ? ' collapsed' : ''}`}
                  onClick={() => toggleCollapse(date)}
                >
                  <span className="collapse-icon">▼</span>
                  <span className="meal-day-date">
                    {friendlyDate(date)} <span className="weekday">{weekdayName(date)}</span>
                  </span>
                  {date === today && <span className="today-badge">Today</span>}
                  <div className="meal-day-summary">
                    <span className="meal-day-cal-total">{Math.round(dayCal).toLocaleString()} cal</span>
                    <div className="meal-day-macro-strip">
                      <div className="seg" style={{ width: `${(dayPro / macroTotal) * 100}%`, background: 'var(--color-protein)' }} />
                      <div className="seg" style={{ width: `${(dayCarb / macroTotal) * 100}%`, background: 'var(--color-carbs)' }} />
                      <div className="seg" style={{ width: `${(dayFat / macroTotal) * 100}%`, background: 'var(--color-fat)' }} />
                    </div>
                    <span className="meal-day-meal-count">{dayMeals.length} meal{dayMeals.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Day Body */}
                <div className={`meal-day-body${isCollapsed ? ' collapsed' : ''}`}>
                  {dayMeals.map(meal => {
                    const isExpanded = expandedMeals.has(meal.id)
                    const isEditingThisItems = editingItemsId === meal.id

                    if (editingId === meal.id) {
                      return <EditRow key={meal.id} />
                    }

                    return (
                      <div className={`meal-grid-row${isExpanded ? ' expanded' : ''}`} key={meal.id}>
                        <div className="meal-grid-cell">
                          <span className={`meal-pill ${getMealClass(meal.meal)}`}>{meal.meal}</span>
                        </div>
                        <div
                          className="meal-grid-desc expandable"
                          onClick={() => toggleMealExpand(meal.id)}
                          title={meal.description}
                        >
                          <span className="expand-arrow">{isExpanded ? '▾' : '›'}</span>
                          {meal.description}
                          {meal.confidence != null && (
                            <span
                              className={`confidence-dot ${meal.confidence > 0.7 ? 'high' : meal.confidence >= 0.4 ? 'medium' : 'low'}`}
                              title={`${(meal.confidence * 100).toFixed(0)}% confidence`}
                              style={{ marginLeft: 6 }}
                            />
                          )}
                        </div>
                        <div className="meal-macro-cell">
                          <span className="num" style={{ color: 'var(--color-protein)' }}>{Math.round(meal.protein_g)}</span>
                          <div className="meal-micro-bar">
                            <div className="fill" style={{ width: `${dayPro ? Math.min(100, (meal.protein_g / dayPro) * 100) : 0}%`, background: 'var(--color-protein)' }} />
                          </div>
                        </div>
                        <div className="meal-macro-cell">
                          <span className="num" style={{ color: 'var(--color-carbs)' }}>{Math.round(meal.carbs_g)}</span>
                          <div className="meal-micro-bar">
                            <div className="fill" style={{ width: `${dayCarb ? Math.min(100, (meal.carbs_g / dayCarb) * 100) : 0}%`, background: 'var(--color-carbs)' }} />
                          </div>
                        </div>
                        <div className="meal-macro-cell meal-macro-hide-mobile">
                          <span className="num" style={{ color: 'var(--color-fat)' }}>{Math.round(meal.fat_g)}</span>
                          <div className="meal-micro-bar">
                            <div className="fill" style={{ width: `${dayFat ? Math.min(100, (meal.fat_g / dayFat) * 100) : 0}%`, background: 'var(--color-fat)' }} />
                          </div>
                        </div>
                        <div className="meal-macro-cell meal-macro-hide-mobile">
                          <span className="num" style={{ color: 'var(--color-fiber)' }}>{Math.round(meal.fiber_g)}</span>
                          <div className="meal-micro-bar">
                            <div className="fill" style={{ width: `${dayFiber ? Math.min(100, (meal.fiber_g / dayFiber) * 100) : 0}%`, background: 'var(--color-fiber)' }} />
                          </div>
                        </div>
                        <div className="meal-cal-cell">{Math.round(meal.calories)}</div>
                        <div className="meal-grid-cell actions-cell-container">
                          <div className="actions-cell">
                            <button className="action-btn duplicate" onClick={() => handleDuplicate(meal.id)} title="Duplicate">📋</button>
                            <button className="action-btn delete" onClick={() => handleDelete(meal.id)} title="Delete">🗑️</button>
                          </div>
                        </div>

                        {/* Items drawer */}
                        <div className={`meal-items-drawer${isExpanded ? ' open' : ''}`}>
                          {isEditingThisItems ? (
                            /* Edit mode — grid aligned with meal row */
                            <>
                              <div className="item-edit-header">
                                <span className="item-edit-label qty">Qty</span>
                                <span className="item-edit-label">Name</span>
                                <span className="item-edit-label num">P</span>
                                <span className="item-edit-label num">C</span>
                                <span className="item-edit-label num meal-macro-hide-mobile">F</span>
                                <span className="item-edit-label num meal-macro-hide-mobile">Fb</span>
                                <span className="item-edit-label num">Cal</span>
                                <span className="item-edit-label del"></span>
                              </div>
                              {itemDrafts.map((item, idx) => (
                                <div className="item-edit-row" key={idx}>
                                  <input
                                    className="item-edit-input qty"
                                    value={item.quantity}
                                    onChange={e => updateItemDraft(idx, 'quantity', e.target.value)}
                                    placeholder="Qty"
                                  />
                                  <input
                                    className="item-edit-input name"
                                    value={item.name}
                                    onChange={e => updateItemDraft(idx, 'name', e.target.value)}
                                    placeholder="Item name"
                                  />
                                  <input
                                    className="item-edit-input num"
                                    type="number"
                                    value={item.protein_g || ''}
                                    onChange={e => updateItemDraft(idx, 'protein_g', parseFloat(e.target.value) || 0)}
                                  />
                                  <input
                                    className="item-edit-input num"
                                    type="number"
                                    value={item.carbs_g || ''}
                                    onChange={e => updateItemDraft(idx, 'carbs_g', parseFloat(e.target.value) || 0)}
                                  />
                                  <input
                                    className="item-edit-input num meal-macro-hide-mobile"
                                    type="number"
                                    value={item.fat_g || ''}
                                    onChange={e => updateItemDraft(idx, 'fat_g', parseFloat(e.target.value) || 0)}
                                  />
                                  <input
                                    className="item-edit-input num meal-macro-hide-mobile"
                                    type="number"
                                    value={item.fiber_g || ''}
                                    onChange={e => updateItemDraft(idx, 'fiber_g', parseFloat(e.target.value) || 0)}
                                  />
                                  <input
                                    className="item-edit-input num"
                                    type="number"
                                    value={item.calories || ''}
                                    onChange={e => updateItemDraft(idx, 'calories', parseFloat(e.target.value) || 0)}
                                  />
                                  <button className="item-delete-btn" onClick={() => removeItemDraft(idx)} title="Remove item">✕</button>
                                </div>
                              ))}
                              <div className="item-edit-actions">
                                <button className="item-action-btn add" onClick={addItemDraft}>+ Add Item</button>
                                <div className="item-edit-actions-right">
                                  <button className="item-action-btn save" onClick={saveItemEdits}>Save</button>
                                  <button className="item-action-btn cancel" onClick={cancelItemEdit}>Cancel</button>
                                </div>
                              </div>
                            </>
                          ) : (
                            /* Read-only mode — grid aligned with meal row */
                            <>
                              {(meal.items || []).length > 0 && (
                                <div className="item-col-header">
                                  <span>Qty</span>
                                  <span>Item</span>
                                  <span>P</span>
                                  <span>C</span>
                                  <span className="meal-macro-hide-mobile">F</span>
                                  <span className="meal-macro-hide-mobile">Fb</span>
                                  <span>Cal</span>
                                  <span style={{ fontSize: '0.6rem' }}>Conf</span>
                                </div>
                              )}
                              {(meal.items || []).map((item, idx) => (
                                <div className="item-row" key={idx}>
                                  <div className="item-qty">{item.quantity}</div>
                                  <div className="item-name">{item.name}</div>
                                  <div className="item-macro protein">{Math.round(item.protein_g)}</div>
                                  <div className="item-macro carbs">{Math.round(item.carbs_g)}</div>
                                  <div className="item-macro fat meal-macro-hide-mobile">{Math.round(item.fat_g)}</div>
                                  <div className="item-macro fiber meal-macro-hide-mobile">{Math.round(item.fiber_g)}</div>
                                  <div className="item-macro cal">{Math.round(item.calories)}</div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 60 }}>
                                    {item.confidence != null && (
                                      <>
                                        <span className={`confidence-dot ${item.confidence > 0.7 ? 'high' : item.confidence >= 0.4 ? 'medium' : 'low'}`} />
                                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                          {(item.confidence * 100).toFixed(0)}%
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              ))}
                              <div className="item-drawer-actions">
                                {meal.items?.length ? (
                                  <button className="item-action-btn edit" onClick={() => startItemEdit(meal)}>✏️ Edit Items</button>
                                ) : null}
                                <button className="item-action-btn edit-meal" onClick={() => startEdit(meal)}>✏️ Edit Meal</button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Empty state */}
          {groupedByDate.size === 0 && !isAdding && (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
              No meals found for the selected filters.
            </div>
          )}
        </>
      )}
    </>
  )
}
