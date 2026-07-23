/**
 * ShoppingList -- grouped grocery list with aisle/recipe views,
 * optimistic checkbox toggling, and manual item entry.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  listShoppingItems,
  addShoppingItem,
  updateShoppingItem,
  deleteShoppingItem,
  clearCompletedShoppingItems,
  clearAllShoppingItems,
  type ShoppingListItem,
} from '../api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_EMOJI: Record<string, string> = {
  Produce: '\u{1F96C}',
  Dairy: '\u{1F9C8}',
  Meat: '\u{1F969}',
  Pantry: '\u{1F36C}',
  Spices: '\u{1F336}\uFE0F',
  Other: '\u{1F4E6}',
}

const CATEGORIES = ['Produce', 'Dairy', 'Meat', 'Pantry', 'Spices', 'Other'] as const

// Preferred display order for aisle view
const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  CATEGORIES.map((c, i) => [c, i])
)

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ShoppingList() {
  const [items, setItems] = useState<ShoppingListItem[]>([])
  const [viewMode, setViewMode] = useState<'aisle' | 'recipe'>('aisle')
  const [newName, setNewName] = useState('')
  const [newAmt, setNewAmt] = useState('')
  const [newUnit, setNewUnit] = useState('')
  const [newCat, setNewCat] = useState('Other')
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // ---- Fetch on mount ----
  useEffect(() => {
    listShoppingItems()
      .then(setItems)
      .finally(() => setLoading(false))
  }, [])

  // ---- Derived data ----
  const checkedCount = useMemo(() => items.filter((i) => i.checked).length, [items])

  const grouped = useMemo(() => {
    const groups: Record<string, ShoppingListItem[]> = {}
    for (const item of items) {
      const key = viewMode === 'aisle' ? item.category : (item.recipe_name || 'Other')
      ;(groups[key] = groups[key] || []).push(item)
    }
    // Sort group keys: aisle mode uses preferred order, recipe mode alphabetical
    const sortedKeys =
      viewMode === 'aisle'
        ? Object.keys(groups).sort(
            (a, b) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99)
          )
        : Object.keys(groups).sort()
    const sorted: Record<string, ShoppingListItem[]> = {}
    for (const k of sortedKeys) sorted[k] = groups[k]
    return sorted
  }, [items, viewMode])

  // ---- Handlers ----

  const toggleCheck = useCallback(
    (item: ShoppingListItem) => {
      const next = !item.checked
      // Optimistic update
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: next } : i)))
      updateShoppingItem(item.id, { checked: next }).catch(() => {
        // Revert on failure
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: !next } : i)))
      })
    },
    []
  )

  const handleAdd = useCallback(() => {
    const name = newName.trim()
    if (!name) return
    const payload: { name: string; amount?: number; unit?: string; category?: string } = { name }
    const parsed = parseFloat(newAmt)
    if (!isNaN(parsed) && parsed > 0) payload.amount = parsed
    const unit = newUnit.trim()
    if (unit) payload.unit = unit
    if (newCat !== 'Other') payload.category = newCat

    addShoppingItem(payload).then((created) => {
      setItems((prev) => [created, ...prev])
      setNewName('')
      setNewAmt('')
      setNewUnit('')
      setNewCat('Other')
    })
  }, [newName, newAmt, newUnit, newCat])

  const handleDelete = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    deleteShoppingItem(id).catch(() => {
      // Re-fetch on failure to restore state
      listShoppingItems().then(setItems)
    })
  }, [])

  const handleClearCompleted = useCallback(() => {
    setItems((prev) => prev.filter((i) => !i.checked))
    clearCompletedShoppingItems().catch(() => {
      listShoppingItems().then(setItems)
    })
  }, [])

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const [copyLabel, setCopyLabel] = useState('Copy list')

  const handleCopyList = useCallback(() => {
    const text = items
      .map((i) => {
        let line = i.name
        if (i.amount || i.unit) {
          line += ' - '
          if (i.amount) line += String(i.amount)
          if (i.unit) line += ` ${i.unit}`
        }
        return line
      })
      .join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopyLabel('Copied!')
      setTimeout(() => setCopyLabel('Copy list'), 1500)
    })
  }, [items])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleAdd()
    },
    [handleAdd]
  )

  // ---- Render ----

  if (loading) {
    return (
      <div className="page-content-narrow">
        <div className="sl-header">
          <div className="sl-header-left">
            <h1>{'\u{1F6D2}'} Shopping List</h1>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content-narrow">
      {/* Header */}
      <div className="sl-header">
        <div className="sl-header-left">
          <h1>{'\u{1F6D2}'} Shopping List</h1>
          <span className="sl-count">
            {items.length} item{items.length !== 1 ? 's' : ''}
            {checkedCount > 0 ? `, ${checkedCount} checked` : ''}
          </span>
        </div>
        <div className="sl-toggle">
          <button
            className={viewMode === 'aisle' ? 'active' : ''}
            onClick={() => setViewMode('aisle')}
          >
            Aisle
          </button>
          <button
            className={viewMode === 'recipe' ? 'active' : ''}
            onClick={() => setViewMode('recipe')}
          >
            Recipe
          </button>
        </div>
      </div>

      {/* Groups */}
      {items.length === 0 ? (
        <div className="sl-empty">
          <div className="sl-empty-icon">{'\u{1F6D2}'}</div>
          <div className="sl-empty-title">Your list is empty</div>
          <div className="sl-empty-sub">
            Add items manually below or send ingredients from a recipe.
          </div>
        </div>
      ) : (
        Object.entries(grouped).map(([groupKey, groupItems]) => {
          const isCollapsed = !!collapsed[groupKey]
          return (
            <div
              key={groupKey}
              className={`sl-group${isCollapsed ? ' collapsed' : ''}`}
            >
              <div
                className="sl-group-header"
                onClick={() => toggleGroup(groupKey)}
              >
                <span className="sl-group-label">
                  {viewMode === 'aisle' && (
                    <span className="cat-emoji">
                      {CATEGORY_EMOJI[groupKey] || CATEGORY_EMOJI.Other}
                    </span>
                  )}
                  {groupKey}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="sl-group-count">{groupItems.length}</span>
                  <span className="sl-group-arrow">{'\u25BC'}</span>
                </div>
              </div>
              <div className="sl-group-body">
                {groupItems.map((item) => (
                  <div
                    key={item.id}
                    className={`sl-item${item.checked ? ' checked' : ''}`}
                    onClick={() => toggleCheck(item)}
                  >
                    <button className="sl-check">{'\u2713'}</button>
                    <div className="sl-item-body">
                      <span className="sl-item-name">{item.name}</span>
                      {(item.amount || item.unit) && (
                        <span className="sl-item-qty">
                          {item.amount ?? ''}{item.unit ? ` ${item.unit}` : ''}
                        </span>
                      )}
                      {item.recipe_name && (
                        <span className="sl-item-recipe">{item.recipe_name}</span>
                      )}
                      {item.exotic && (
                        <span className="sl-item-exotic" title="Specialty item">
                          {'\u2728'}
                        </span>
                      )}
                    </div>
                    <button
                      className="sl-item-delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(item.id)
                      }}
                    >
                      {'\u2715'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}

      {/* Add form */}
      <div className="sl-add-form">
        <input
          className="sl-add-name"
          type="text"
          placeholder="Add item..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          className="sl-add-amt"
          type="text"
          placeholder="Amt"
          value={newAmt}
          onChange={(e) => setNewAmt(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          className="sl-add-unit"
          type="text"
          placeholder="Unit"
          value={newUnit}
          onChange={(e) => setNewUnit(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
          <option value="Other">Category</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button className="sl-add-btn" onClick={handleAdd}>
          Add
        </button>
      </div>

      {/* Bottom actions */}
      {items.length > 0 && (
        <div className="sl-bottom">
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sl-copy-btn" onClick={handleCopyList}>
              {copyLabel}
            </button>
            {checkedCount > 0 && (
              <button className="sl-clear-btn" onClick={handleClearCompleted}>
                Clear completed ({checkedCount})
              </button>
            )}
            <button className="sl-clear-btn" onClick={() => {
              if (!confirm('Clear entire shopping list?')) return
              setItems([])
              clearAllShoppingItems().catch(() => { listShoppingItems().then(setItems) })
            }}>
              Clear list
            </button>
          </div>
          <span className="sl-total">
            {items.length} item{items.length !== 1 ? 's' : ''} total
          </span>
        </div>
      )}
    </div>
  )
}
