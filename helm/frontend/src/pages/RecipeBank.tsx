/**
 * RecipeBank — browse, search, add/edit recipes with cook log tracking and ingredient scaling.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe,
  listRecipeTags, createCookLog, updateCookLog, deleteCookLog, deleteCookLogPhoto,
  scaleIngredients, uploadRecipePhoto, deleteRecipePhoto, fetchRecipePhotoBlob,
  parseRecipeUrlAsync, parseRecipeTextAsync,
  uploadCookLogPhoto, getCookLogPhotoUrl,
  addShoppingItem, classifyIngredientsAsync,
  getCurrentUserRole, getCurrentUsername,
  type RecipeListResponse, type RecipeResponse, type RecipeCreate,
  type RecipeIngredientData, type ScaledIngredient,
} from '../api'
import { useContextJobs } from '../useContextJobs'
import { todayISO } from '../dates'
import {
  recipeGradient, recipeEmoji, tagClass,
  parseInstructions, formatDate, ratingToDots, relativeDate, scaleOriginalUnit,
} from '../utils/recipe-helpers'
import CookLogCard from '../components/CookLogCard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Highlight inline measurements in instruction text (e.g., "120g", "2 tbsp", "350°F"). */
function highlightMeasurements(text: string): React.ReactNode[] {
  const UNITS = [
    // Weight
    'kg', 'oz', 'ounces?', 'lb', 'lbs', 'pounds?', 'g(?!\\w)',
    // Volume — no standalone "l" (matches "large", "lumpia" etc.)
    'ml', 'liters?', 'litres?', 'cups?', 'tbsp', 'tablespoons?', 'tsp', 'teaspoons?',
    'quarts?', 'gallons?', 'pints?', 'fl\\.?\\s*oz',
    // Cooking items
    'cloves?', 'pinch(?:es)?', 'dash(?:es)?',
    'slices?', 'pieces?', 'cans?', 'bunche?s?', 'stalks?', 'sprigs?', 'heads?',
  ].join('|')

  const FRAC = '[\\u00BC-\\u00BE\\u2150-\\u215E]'
  const NUM = `(?:\\d+\\s+\\d+/\\d+|\\d+\\s*${FRAC}|\\d+\\.\\d+|\\d+/\\d+|${FRAC}|\\d+)`
  const RANGE = `${NUM}(?:\\s*[-\\u2013]\\s*${NUM})?`
  const AFTER = `(?=\\s|[,.()!;:]|$)`

  const patterns = [
    // Parenthesized amounts: "(1/2 cup)", "(3 ⅓ cups)"  — parens always paired
    `\\(${RANGE}\\s*(?:${UNITS})\\s*\\)${AFTER}`,
    // Bare amounts: "2 cups", "350g", "2-4 tablespoons"
    `${RANGE}\\s*(?:${UNITS})${AFTER}`,
    // Temperature: "350°F", "180°C", "375℉", "200℃", "350 degrees F"
    `${NUM}\\s*(?:[°]\\s*[FC]|[\\u2109\\u2103]|degrees?\\s*[FC])`,
    // Cooking times: "15 minutes", "2 hours", "1.5 - 2 more hours", "30 min"
    `${RANGE}\\s*(?:more\\s+)?(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)${AFTER}`,
  ]

  const pattern = new RegExp(`(?<=^|[^a-zA-Z])(?:${patterns.join('|')})`, 'gi')
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(<span key={match.index} className="rb-measurement">{match[0]}</span>)
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

/** Group tags by category for the dropdown. */
const TAG_CATEGORIES: { label: string; category: string; tags: string[] }[] = [
  { label: 'Cuisine', category: 'cuisine', tags: ['American', 'Italian', 'Greek', 'Mexican', 'Indian', 'Japanese', 'Chinese', 'French'] },
  { label: 'Course', category: 'course', tags: ['Dinner', 'Lunch', 'Breakfast', 'Appetizer', 'Dessert', 'Side Dish', 'Snack', 'Drink'] },
  { label: 'Dietary', category: 'dietary', tags: ['Vegetarian', 'Vegan', 'Gluten Free', 'Keto', 'Dairy Free', 'Healthy', 'Comfort'] },
  { label: 'Method', category: 'method', tags: ['Baking', 'Grilling', 'Quick', 'Make Ahead'] },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecipeBank() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Auth state
  const userRole = getCurrentUserRole()
  const currentUsername = getCurrentUsername()
  const isAuthenticated = !!userRole
  const isAdmin = userRole === 'admin'

  // Data
  const [recipes, setRecipes] = useState<RecipeListResponse[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({})
  const [detailPhotoUrl, setDetailPhotoUrl] = useState<string | null>(null)
  const [heroSlide, setHeroSlide] = useState(0)
  // Reset slide when photo array changes (recipe photo blob loads async)
  useEffect(() => { setHeroSlide(0) }, [detailPhotoUrl])

  // Filters
  const [search, setSearch] = useState('')
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set())
  const [minRating, setMinRating] = useState(0)
  const [sortBy, setSortBy] = useState('created_at')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [showMineOnly, setShowMineOnly] = useState(false)

  // Tag dropdown
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false)
  const tagFilterRef = useRef<HTMLDivElement>(null)

  // Checked ingredients (local cooking mode state)
  const [checkedIngs, setCheckedIngs] = useState<Set<number>>(new Set())

  // Detail modal
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeResponse | null>(null)
  const [activeTab, setActiveTab] = useState<'recipe' | 'cooklog'>('recipe')
  const [scaleServings, setScaleServings] = useState<number>(0)
  const [scaledIngs, setScaledIngs] = useState<ScaledIngredient[] | null>(null)
  const [useMetric, setUseMetric] = useState(false)

  // Add/Edit modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingRecipe, setEditingRecipe] = useState<RecipeResponse | null>(null)
  const [addMode, setAddMode] = useState<'url' | 'text' | 'manual'>('url')
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [urlInstructions, setUrlInstructions] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [textInstructions, setTextInstructions] = useState('')
  const [formName, setFormName] = useState('')
  const [formInstructions, setFormInstructions] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formServings, setFormServings] = useState('')
  const [formFeeds, setFormFeeds] = useState('')
  const [formSourceUrl, setFormSourceUrl] = useState('')
  const [formPrepAhead, setFormPrepAhead] = useState(false)
  const [formTags, setFormTags] = useState('')
  const [formIngredients, setFormIngredients] = useState<RecipeIngredientData[]>([])
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [removeExistingPhoto, setRemoveExistingPhoto] = useState(false)
  const [editPhotoUrl, setEditPhotoUrl] = useState<string | null>(null)

  // Cook log form
  const [showCookLogForm, setShowCookLogForm] = useState(false)
  const [cookLogDate, setCookLogDate] = useState(todayISO())
  const [cookLogGuests, setCookLogGuests] = useState('')
  const [cookLogNotes, setCookLogNotes] = useState('')
  const [cookLogRating, setCookLogRating] = useState('')
  const [cookLogRatingComment, setCookLogRatingComment] = useState('')
  const [cookLogPhotos, setCookLogPhotos] = useState<File[]>([])
  const [cookLogSaving, setCookLogSaving] = useState(false)
  const cookLogPhotoRef = useRef<HTMLInputElement>(null)
  // Cook log edit
  const [editingCookLogId, setEditingCookLogId] = useState<number | null>(null)
  const [editCookLogDate, setEditCookLogDate] = useState('')
  const [editCookLogGuests, setEditCookLogGuests] = useState('')
  const [editCookLogNotes, setEditCookLogNotes] = useState('')
  const [editCookLogRating, setEditCookLogRating] = useState('')
  const [editCookLogRatingComment, setEditCookLogRatingComment] = useState('')
  const [editCookLogSaving, setEditCookLogSaving] = useState(false)
  const editCookLogPhotoRef = useRef<HTMLInputElement>(null)

  // Toast notification
  const [toast, setToast] = useState<string | null>(null)

  // -----------------------------------------------------------------------
  // Shopping list
  // -----------------------------------------------------------------------

  // Ingredient picker for shopping list
  const [shoppingPicker, setShoppingPicker] = useState<{
    recipeId: number, recipeName: string, scale: number,
    ingredients: { name: string, amount: number | null, unit: string | null, category: string | null, exotic: boolean, selected: boolean }[]
  } | null>(null)
  const [shoppingAdding, setShoppingAdding] = useState(false)
  const [shoppingClassifying, setShoppingClassifying] = useState(false)

  // Ingredient classify — cache hits apply immediately (router-side, no queue trip);
  // cache misses are enqueued (context='ingredient_classify') and applied via poll.
  // On job failure, unresolved items fall back to 'Other' (cache-first + fallback
  // preserved from the sync path).
  const applyCategories = (categories: Record<string, string>) => {
    setShoppingPicker(prev => {
      if (!prev) return null
      return {
        ...prev,
        ingredients: prev.ingredients.map(ing => ({
          ...ing,
          category: categories[ing.name] ?? ing.category ?? 'Other',
        })),
      }
    })
  }

  const { submit: submitClassify } = useContextJobs<Record<string, string>>('ingredient_classify', {
    transform: (raw) => raw as unknown as Record<string, string>,
    onResult: (categories) => {
      applyCategories(categories)
      setShoppingClassifying(false)
    },
    onError: () => {
      // Job failed — fall back to 'Other' for anything still unclassified.
      setShoppingPicker(prev => {
        if (!prev) return null
        return { ...prev, ingredients: prev.ingredients.map(ing => ({ ...ing, category: ing.category || 'Other' })) }
      })
      setShoppingClassifying(false)
    },
  })

  const openShoppingPicker = async (recipeId: number, recipeName: string, scale: number = 1.0, metric: boolean = false) => {
    if (shoppingClassifying || shoppingAdding) return
    try {
      const recipe = selectedRecipe && selectedRecipe.id === recipeId ? selectedRecipe : await getRecipe(recipeId)
      // Open modal immediately with unclassified ingredients
      const ings = recipe.ingredients.map(ing => {
        const useOriginal = !metric && ing.original_unit
        return {
          name: ing.name,
          amount: useOriginal
            ? null
            : (ing.amount ? Math.round(ing.amount * scale * 100) / 100 : null),
          unit: useOriginal
            ? scaleOriginalUnit(ing.original_unit!, scale)
            : ing.unit,
          category: ing.category || 'Other',
          exotic: ing.exotic,
          selected: true,
        }
      })
      setShoppingPicker({ recipeId, recipeName, scale, ingredients: ings })
      // Classify in background — button disabled until done
      setShoppingClassifying(true)
      const names = recipe.ingredients.map(ing => ing.name)
      try {
        const { cached, job_id } = await classifyIngredientsAsync(names)
        if (Object.keys(cached).length > 0) applyCategories(cached)
        if (job_id) {
          await submitClassify(async () => ({ job_id }))
        } else {
          setShoppingClassifying(false)
        }
      } catch {
        // Classification failed — keep existing categories, still allow adding
        setShoppingClassifying(false)
      }
    } catch {
      setToast('Failed to load recipe ingredients')
      setTimeout(() => setToast(null), 3000)
    }
  }

  const handleConfirmShoppingList = async () => {
    if (!shoppingPicker || shoppingAdding || shoppingClassifying) return
    const selected = shoppingPicker.ingredients.filter(i => i.selected)
    if (selected.length === 0) {
      setShoppingPicker(null)
      return
    }
    setShoppingAdding(true)
    try {
      for (const ing of selected) {
        await addShoppingItem({
          name: ing.name,
          amount: ing.amount ?? undefined,
          unit: ing.unit ?? undefined,
          category: ing.category || 'Other',
          recipe_id: shoppingPicker.recipeId,
          recipe_name: shoppingPicker.recipeName,
          exotic: ing.exotic,
        })
      }
      setToast(`Added ${selected.length} items from ${shoppingPicker.recipeName}`)
      setTimeout(() => setToast(null), 3000)
    } catch {
      setToast('Failed to add items')
      setTimeout(() => setToast(null), 3000)
    }
    setShoppingAdding(false)
    setShoppingPicker(null)
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  const loadRecipes = async () => {
    setLoading(true)
    try {
      const params: { search?: string; tags?: string; min_rating?: number; sort_by?: string } = {}
      if (search) params.search = search
      if (activeTags.size > 0) params.tags = Array.from(activeTags).join(',')
      if (minRating > 0) params.min_rating = minRating
      if (sortBy) params.sort_by = sortBy
      const [list, tags] = await Promise.all([listRecipes(params), listRecipeTags()])
      setRecipes(list)
      setAllTags(tags)
      // Fetch photo blobs for recipes with images
      const withPhotos = list.filter(r => r.image_filename)
      if (withPhotos.length > 0) {
        const urls: Record<number, string> = {}
        await Promise.all(withPhotos.map(async r => {
          try { urls[r.id] = await fetchRecipePhotoBlob(r.id, true) } catch { /* no photo */ }
        }))
        setPhotoUrls(prev => ({ ...prev, ...urls }))
      }
    } catch (err) {
      console.error('Failed to load recipes:', err)
    }
    setLoading(false)
  }

  useEffect(() => { loadRecipes() }, [search, activeTags, minRating, sortBy])

  // Deep-link: open recipe detail from ?open= query param (used by Feed page)
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId) {
      const id = parseInt(openId, 10)
      if (!isNaN(id)) openDetail(id)
      setSearchParams({}, { replace: true })
    }
  }, [])

  // Close tag dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (tagFilterRef.current && !tagFilterRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // Client-side "My Recipes" filter
  const displayRecipes = useMemo(() => {
    if (!showMineOnly || !currentUsername) return recipes
    return recipes.filter(r => r.added_by === currentUsername)
  }, [recipes, showMineOnly, currentUsername])

  // Max cook count for frequency bar scaling
  const maxCookCount = useMemo(() => Math.max(1, ...displayRecipes.map(r => r.cook_count)), [displayRecipes])

  // -----------------------------------------------------------------------
  // Detail modal
  // -----------------------------------------------------------------------

  const openDetail = async (id: number) => {
    try {
      const r = await getRecipe(id)
      setSelectedRecipe(r)
      setActiveTab('recipe')
      setScaleServings(r.servings || 1)
      setScaledIngs(null)
      setCheckedIngs(new Set())
      setHeroSlide(0)
      window.history.pushState({ recipeModal: true }, '')
      // Fetch detail photo
      if (r.image_filename) {
        try { setDetailPhotoUrl(await fetchRecipePhotoBlob(r.id)) } catch { setDetailPhotoUrl(null) }
      } else {
        setDetailPhotoUrl(null)
      }
    } catch (err) {
      console.error('Failed to load recipe:', err)
    }
  }

  const closeDetail = useCallback(() => {
    setSelectedRecipe(prev => {
      if (prev && window.history.state?.recipeModal) window.history.back()
      return null
    })
    setShowCookLogForm(false)
  }, [])

  // Back button closes modal instead of navigating away
  useEffect(() => {
    const onPopState = () => {
      if (selectedRecipe) {
        setSelectedRecipe(null)
        setShowCookLogForm(false)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [selectedRecipe])

  /** Open detail modal at a specific tab (for quick action buttons). */
  const openDetailTab = async (id: number, tab: 'recipe' | 'cooklog') => {
    try {
      const r = await getRecipe(id)
      setSelectedRecipe(r)
      setActiveTab(tab)
      setScaleServings(r.servings || 1)
      setScaledIngs(null)
      setCheckedIngs(new Set())
      window.history.pushState({ recipeModal: true }, '')
      if (r.image_filename) {
        try { setDetailPhotoUrl(await fetchRecipePhotoBlob(r.id)) } catch { setDetailPhotoUrl(null) }
      } else {
        setDetailPhotoUrl(null)
      }
      if (tab === 'cooklog') setShowCookLogForm(true)
    } catch (err) {
      console.error('Failed to load recipe:', err)
    }
  }

  /** Toggle an ingredient checkbox. */
  const toggleIngredient = useCallback((idx: number) => {
    setCheckedIngs(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }, [])

  // -----------------------------------------------------------------------
  // Add / Edit modal
  // -----------------------------------------------------------------------

  const resetForm = () => {
    setFormName('')
    setFormInstructions('')
    setFormNotes('')
    setFormServings('')
    setFormFeeds('')
    setFormSourceUrl('')
    setFormPrepAhead(false)
    setFormTags('')
    setFormIngredients([])
    setPhotoFile(null)
    setRemoveExistingPhoto(false)
    setEditPhotoUrl(null)
    setImportUrl('')
    setImporting(false)
    setImportError('')
    setTextInstructions('')
    setPasteText('')
  }

  const openAddModal = () => {
    setEditingRecipe(null)
    resetForm()
    setAddMode('url')
    setShowAddModal(true)
  }

  const openEditModal = async (recipe: RecipeResponse) => {
    setEditingRecipe(recipe)
    setFormName(recipe.name)
    setFormInstructions(recipe.instructions)
    setFormNotes(recipe.notes || '')
    setFormServings(recipe.servings != null ? String(recipe.servings) : '')
    setFormFeeds(recipe.feeds != null ? String(recipe.feeds) : '')
    setFormSourceUrl(recipe.source_url || '')
    setFormPrepAhead(recipe.prep_ahead)
    setFormTags(recipe.tags || '')
    setFormIngredients(recipe.ingredients.map(i => ({
      name: i.name,
      amount: i.amount,
      unit: i.unit,
      original_unit: i.original_unit,
      category: i.category,
      exotic: i.exotic,
      sort_order: i.sort_order,
    })))
    setPhotoFile(null)
    setRemoveExistingPhoto(false)
    if (recipe.image_filename) {
      try { setEditPhotoUrl(await fetchRecipePhotoBlob(recipe.id)) } catch { setEditPhotoUrl(null) }
    } else {
      setEditPhotoUrl(null)
    }
    setAddMode('manual')
    setShowAddModal(true)
  }

  const applyParsed = (parsed: RecipeCreate, url?: string) => {
    setFormName(parsed.name || '')
    setFormInstructions(parsed.instructions || '')
    setFormNotes(parsed.notes || '')
    setFormServings(parsed.servings != null ? String(parsed.servings) : '')
    setFormFeeds(parsed.feeds != null ? String(parsed.feeds) : '')
    setFormSourceUrl(parsed.source_url || url || '')
    setFormPrepAhead(parsed.prep_ahead || false)
    setFormTags(parsed.tags || '')
    setFormIngredients(parsed.ingredients || [])
    setAddMode('manual')
    setImportError('')
    setPasteText('')
  }

  // Recipe parse (URL import / paste-text fallback / from-text) — routed through
  // the llm_jobs queue. No markers to apply; the poll result IS the recipe JSON.
  const pendingSourceUrl = useRef<string | undefined>(undefined)
  const { submit: submitRecipeParse } = useContextJobs<RecipeCreate>('recipe_parse', {
    transform: (raw) => raw as unknown as RecipeCreate,
    onResult: (parsed) => {
      applyParsed(parsed, pendingSourceUrl.current)
      setImporting(false)
    },
    onError: () => {
      setImportError('Could not parse a recipe from that input. Try manual entry.')
      setImporting(false)
    },
  })

  const handleImport = async () => {
    if (!importUrl.trim()) return
    setImporting(true)
    setImportError('')
    pendingSourceUrl.current = importUrl.trim()
    try {
      await submitRecipeParse(() => parseRecipeUrlAsync(importUrl.trim(), urlInstructions.trim() || undefined))
    } catch (err) {
      console.error('Import failed:', err)
      setImportError('Could not fetch that URL (site may block bots). Paste the recipe text below instead.')
      setImporting(false)
    }
  }

  const handlePasteImport = async () => {
    if (!pasteText.trim()) return
    setImporting(true)
    setImportError('')
    pendingSourceUrl.current = importUrl.trim() || undefined
    try {
      await submitRecipeParse(() => parseRecipeTextAsync(pasteText.trim(), importUrl.trim() || undefined))
    } catch (err) {
      console.error('Paste import failed:', err)
      setImportError('Failed to parse recipe from pasted text. Try manual entry.')
      setImporting(false)
    }
  }

  const handleTextParse = async () => {
    if (!pasteText.trim()) return
    setImporting(true)
    setImportError('')
    pendingSourceUrl.current = undefined
    try {
      await submitRecipeParse(() => parseRecipeTextAsync(pasteText.trim(), undefined, textInstructions.trim() || undefined))
    } catch (err) {
      console.error('Text parse failed:', err)
      setImportError('Failed to parse recipe from text. Try manual entry.')
      setImporting(false)
    }
  }

  const handleSave = async () => {
    if (!formName.trim()) { alert('Recipe name is required.'); return }
    const data: RecipeCreate = {
      name: formName.trim(),
      instructions: formInstructions,
      notes: formNotes || null,
      servings: formServings ? parseInt(formServings) : null,
      feeds: formFeeds ? parseInt(formFeeds) : null,
      source_url: formSourceUrl || null,
      prep_ahead: formPrepAhead,
      tags: formTags || null,
      ingredients: formIngredients.map((ing, idx) => ({ ...ing, unit: ing.amount != null ? (ing.unit || 'g') : null, sort_order: idx })),
    }
    try {
      let saved: RecipeResponse
      if (editingRecipe) {
        saved = await updateRecipe(editingRecipe.id, data)
      } else {
        saved = await createRecipe(data)
      }
      if (removeExistingPhoto && !photoFile) {
        try { await deleteRecipePhoto(saved.id) } catch { /* already gone */ }
      }
      if (photoFile) {
        try { await uploadRecipePhoto(saved.id, photoFile) } catch (e) { alert('Recipe saved, but photo upload failed. You can add the photo by editing the recipe.') }
      }
      setShowAddModal(false)
      resetForm()
      await loadRecipes()
      // If we were viewing the detail and editing, refresh it
      if (selectedRecipe && editingRecipe && selectedRecipe.id === editingRecipe.id) {
        await openDetail(saved.id)
      }
    } catch (err) {
      console.error('Save failed:', err)
      alert('Failed to save recipe.')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this recipe? This cannot be undone.')) return
    try {
      await deleteRecipe(id)
      closeDetail()
      await loadRecipes()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  // -----------------------------------------------------------------------
  // Scaling
  // -----------------------------------------------------------------------

  const handleScaleChange = async (newServings: number) => {
    setScaleServings(newServings)
    if (!selectedRecipe || newServings <= 0) return
    try {
      const scaled = await scaleIngredients(selectedRecipe.id, newServings)
      setScaledIngs(scaled)
    } catch (err) {
      console.error('Scale failed:', err)
    }
  }

  // -----------------------------------------------------------------------
  // Cook log
  // -----------------------------------------------------------------------

  const handleAddCookLog = async () => {
    if (!selectedRecipe || cookLogSaving) return
    setCookLogSaving(true)
    try {
      const log = await createCookLog(selectedRecipe.id, {
        date: cookLogDate,
        guests: cookLogGuests ? parseInt(cookLogGuests) : null,
        notes: cookLogNotes || null,
        rating: cookLogRating ? parseFloat(cookLogRating) : null,
        rating_comment: cookLogRatingComment || null,
      })
      // Upload any selected photos
      for (const file of cookLogPhotos) {
        try { await uploadCookLogPhoto(selectedRecipe.id, log.id, file) } catch { /* continue */ }
      }
      setShowCookLogForm(false)
      setCookLogDate(todayISO())
      setCookLogGuests('')
      setCookLogNotes('')
      setCookLogRating('')
      setCookLogRatingComment('')
      setCookLogPhotos([])
      await openDetail(selectedRecipe.id)
      await loadRecipes()
    } catch (err) {
      console.error('Failed to add cook log:', err)
    }
    setCookLogSaving(false)
  }

  const handleDeleteCookLog = async (cookId: number) => {
    if (!selectedRecipe || !confirm('Delete this cook log?')) return
    try {
      await deleteCookLog(selectedRecipe.id, cookId)
      setEditingCookLogId(null)
      await openDetail(selectedRecipe.id)
      await loadRecipes()
    } catch (err) {
      console.error('Failed to delete cook log:', err)
    }
  }

  const startEditCookLog = (log: { id: number, date: string, guests?: number | null, notes?: string | null, rating?: number | null, rating_comment?: string | null }) => {
    setEditingCookLogId(log.id)
    setEditCookLogDate(log.date)
    setEditCookLogGuests(log.guests != null ? String(log.guests) : '')
    setEditCookLogNotes(log.notes || '')
    setEditCookLogRating(log.rating != null ? String(log.rating) : '')
    setEditCookLogRatingComment(log.rating_comment || '')
  }

  const handleSaveEditCookLog = async () => {
    if (!selectedRecipe || !editingCookLogId || editCookLogSaving) return
    setEditCookLogSaving(true)
    try {
      await updateCookLog(selectedRecipe.id, editingCookLogId, {
        date: editCookLogDate,
        guests: editCookLogGuests ? parseInt(editCookLogGuests) : null,
        notes: editCookLogNotes || null,
        rating: editCookLogRating ? parseFloat(editCookLogRating) : null,
        rating_comment: editCookLogRatingComment || null,
      })
      setEditingCookLogId(null)
      await openDetail(selectedRecipe.id)
      await loadRecipes()
    } catch (err) {
      console.error('Failed to update cook log:', err)
    }
    setEditCookLogSaving(false)
  }

  // -----------------------------------------------------------------------
  // Ingredient form helpers
  // -----------------------------------------------------------------------

  const addIngredientRow = () => {
    setFormIngredients(prev => [...prev, { name: '', amount: null, unit: null, original_unit: null, category: null, exotic: false, sort_order: prev.length }])
  }

  const removeIngredientRow = (index: number) => {
    setFormIngredients(prev => prev.filter((_, i) => i !== index))
  }

  const updateIngredient = (index: number, field: keyof RecipeIngredientData, value: string | number | boolean | null) => {
    setFormIngredients(prev => prev.map((ing, i) => i === index ? { ...ing, [field]: value } : ing))
  }

  // -----------------------------------------------------------------------
  // Tag filter toggle
  // -----------------------------------------------------------------------

  const toggleTag = (tag: string) => {
    if (tag === 'all') {
      setActiveTags(new Set())
    } else {
      setActiveTags(prev => {
        const next = new Set(prev)
        next.has(tag) ? next.delete(tag) : next.add(tag)
        return next
      })
    }
  }

  // -----------------------------------------------------------------------
  // Derived data
  // -----------------------------------------------------------------------

  // Group ingredients by category for detail view
  const groupedIngredients = useMemo(() => {
    if (!selectedRecipe) return new Map<string, RecipeResponse['ingredients']>()
    const groups = new Map<string, RecipeResponse['ingredients']>()
    for (const ing of selectedRecipe.ingredients) {
      const cat = ing.category || 'Ingredients'
      const existing = groups.get(cat) || []
      existing.push(ing)
      groups.set(cat, existing)
    }
    return groups
  }, [selectedRecipe])

  // Group scaled ingredients by category
  const groupedScaledIngs = useMemo(() => {
    if (!scaledIngs) return null
    const groups = new Map<string, ScaledIngredient[]>()
    for (const ing of scaledIngs) {
      const cat = ing.category || 'Ingredients'
      const existing = groups.get(cat) || []
      existing.push(ing)
      groups.set(cat, existing)
    }
    return groups
  }, [scaledIngs])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="page-content-narrow">
      {/* Page header */}
      <div className="page-header" style={{ marginBottom: 'var(--space-md)' }}>
        <div>
          <h1>Recipe Bank</h1>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {recipes.length} recipe{recipes.length !== 1 ? 's' : ''}
          </span>
        </div>
        {isAuthenticated && <button className="btn btn-primary" onClick={openAddModal}>+ Add Recipe</button>}
      </div>

      {/* Filter bar */}
      <div className="rb-filter-bar">
        <div className="rb-search-box">
          <span className="rb-search-icon">{'\u{1F50D}'}</span>
          <input
            type="text"
            placeholder="Search recipes..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />

        {/* Tag dropdown filter */}
        <div className="rb-tag-filter" ref={tagFilterRef}>
          <button
            className={`rb-tag-filter-btn${activeTags.size > 0 ? ' has-active' : ''}${tagDropdownOpen ? ' open' : ''}`}
            onClick={() => setTagDropdownOpen(prev => !prev)}
          >
            Tags
            {activeTags.size > 0 && <span className="rb-tag-filter-count">{activeTags.size}</span>}
            <span className="rb-chevron">{'\u25BE'}</span>
          </button>
          <div className={`rb-tag-dropdown${tagDropdownOpen ? ' open' : ''}`}>
            {TAG_CATEGORIES.map(cat => {
              // Only show tags that exist in the recipe data (plus the category defaults)
              const available = cat.tags.filter(t => allTags.some(at => at.toLowerCase() === t.toLowerCase()) || activeTags.has(t))
              if (available.length === 0) return null
              return (
                <div key={cat.label} className="rb-tag-group">
                  <div className="rb-tag-group-label">{cat.label}</div>
                  <div className="rb-tag-group-chips">
                    {available.map(t => (
                      <button
                        key={t}
                        className={`rb-tag-chip${activeTags.has(t) ? ' active' : ''}`}
                        onClick={() => toggleTag(t)}
                      >{t}</button>
                    ))}
                  </div>
                </div>
              )
            })}
            {/* Show any remaining tags not in categories */}
            {allTags.filter(t => !TAG_CATEGORIES.some(c => c.tags.some(ct => ct.toLowerCase() === t.toLowerCase()))).length > 0 && (
              <div className="rb-tag-group">
                <div className="rb-tag-group-label">Other</div>
                <div className="rb-tag-group-chips">
                  {allTags.filter(t => !TAG_CATEGORIES.some(c => c.tags.some(ct => ct.toLowerCase() === t.toLowerCase()))).map(t => (
                    <button
                      key={t}
                      className={`rb-tag-chip${activeTags.has(t) ? ' active' : ''}`}
                      onClick={() => toggleTag(t)}
                    >{t}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Active tag pills */}
        {activeTags.size > 0 && (
          <div className="rb-active-tags">
            {Array.from(activeTags).map(tag => (
              <span key={tag} className="rb-active-tag-pill">
                {tag}
                <button className="rb-active-tag-remove" onClick={() => toggleTag(tag)}>&times;</button>
              </span>
            ))}
          </div>
        )}

        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />

        {/* Rating filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
          {'Min \u2B50'}
          <select
            className="rb-select"
            value={minRating}
            onChange={e => setMinRating(parseInt(e.target.value))}
          >
            <option value={0}>Any</option>
            <option value={6}>6+</option>
            <option value={7}>7+</option>
            <option value={8}>8+</option>
            <option value={9}>9+</option>
          </select>
        </div>

        {isAuthenticated && (
          <>
            <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />
            <button
              className={`rb-mine-toggle${showMineOnly ? ' active' : ''}`}
              onClick={() => setShowMineOnly(p => !p)}
            >
              My Recipes
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Sort */}
        <select
          className="rb-select"
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
        >
          <option value="rating">Rating (High)</option>
          <option value="name">Name (A-Z)</option>
          <option value="created_at">Newest</option>
          <option value="updated_at">Recently Updated</option>
        </select>

        {/* View toggle */}
        <div className="rb-view-toggle">
          <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>{'\u{25A6}'}</button>
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>{'\u{2630}'}</button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="loading-overlay"><span className="loading-spinner" /> Loading recipes...</div>
      ) : displayRecipes.length === 0 ? (
        <div className="rb-empty-state">
          <div className="rb-empty-state-icon">{'\u{1F373}'}</div>
          <div>No recipes found. Add your first recipe to get started!</div>
        </div>
      ) : (
        <>
          {/* Grid view */}
          {viewMode === 'grid' && (
            <div className="rb-grid">
              {displayRecipes.map(r => {
                const lastCooked = relativeDate(r.last_cooked)
                return (
                  <div key={r.id} className="rb-card" onClick={() => openDetail(r.id)}>
                    <div className="rb-card-img">
                      {(() => {
                        const photos: string[] = []
                        if (r.image_filename && photoUrls[r.id]) photos.push(photoUrls[r.id])
                        for (const fn of (r.cook_photos || [])) photos.push(getCookLogPhotoUrl(fn, true))
                        if (photos.length === 0) {
                          return (
                            <div className="rb-card-img-placeholder" style={{ background: recipeGradient(r.name) }}>
                              {recipeEmoji(r.tags)}
                            </div>
                          )
                        }
                        return <img src={photos[0]} alt={r.name} className="rb-card-photo img-fade" loading="lazy" onLoad={e => (e.target as HTMLImageElement).classList.add('loaded')} />
                      })()}
                      {isAuthenticated && (
                        <div className="rb-card-actions">
                          <button className="rb-card-action-btn" title="Log a cook" onClick={e => { e.stopPropagation(); openDetailTab(r.id, 'cooklog') }}>{'\u{1F373}'}</button>
                          <button className="rb-card-action-btn" title="Add to Shopping List" onClick={e => { e.stopPropagation(); openShoppingPicker(r.id, r.name) }}>{'\u{1F6D2}'}</button>
                        </div>
                      )}
                    </div>
                    <div className="rb-card-body">
                      {r.rating != null && (
                        <div className="rb-rating-dots">
                          <div className="rb-rating-dot-row">
                            {ratingToDots(r.rating).map((dot, i) => (
                              <div key={i} className={`rb-rating-dot ${dot}`} />
                            ))}
                          </div>
                          <span className="rb-rating-number">{r.rating}</span>
                        </div>
                      )}
                      <div className="rb-card-name">{r.name}</div>
                      {r.added_by && (
                        <span className="rb-attribution">
                          <span className="rb-avatar">{r.added_by[0].toUpperCase()}</span>
                          {r.added_by}
                        </span>
                      )}
                      <div className="rb-card-meta">
                        {r.feeds != null ? (
                          <span>Feeds {r.feeds}</span>
                        ) : r.servings != null ? (
                          <span>{r.servings} servings</span>
                        ) : null}
                        {r.prep_ahead && (
                          <>
                            <span className="rb-dot" />
                            <span className="rb-prep-badge">Make Ahead</span>
                          </>
                        )}
                        {lastCooked && (
                          <>
                            <span className="rb-dot" />
                            <span className="rb-last-cooked">Cooked {lastCooked}</span>
                          </>
                        )}
                        {!lastCooked && r.cook_count === 0 && (
                          <>
                            <span className="rb-dot" />
                            <span>Never cooked</span>
                          </>
                        )}
                      </div>
                      <div className="rb-cook-freq">
                        <div className="rb-cook-freq-bar">
                          <div className="rb-cook-freq-fill" style={{ width: `${(r.cook_count / maxCookCount) * 100}%` }} />
                        </div>
                        <span className="rb-cook-freq-label">{r.cook_count} cook{r.cook_count !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="rb-card-tags">
                        {r.tags && r.tags.split(',').map(t => t.trim()).filter(t => t && t.toLowerCase() !== 'make ahead').map(t => (
                          <span key={t} className={`rb-tag ${tagClass(t)}`}>{t}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* List view */}
          {viewMode === 'list' && (
            <div className="rb-list">
              <div className="rb-list-header">
                <span>Name</span>
                <span>Rating</span>
                <span>Tags</span>
                <span>By</span>
                <span>Added</span>
                <span style={{ textAlign: 'right' }}>Cooks</span>
              </div>
              {displayRecipes.map(r => (
                <div key={r.id} className="rb-list-row" onClick={() => openDetail(r.id)}>
                  <span className="rb-list-name">{r.name}</span>
                  <span className="rb-list-rating">
                    {r.rating != null ? (
                      <span className="rb-rating-dots" style={{ marginBottom: 0 }}>
                        <span className="rb-rating-dot-row" style={{ gap: 2 }}>
                          {ratingToDots(r.rating).map((dot, i) => (
                            <span key={i} className={`rb-rating-dot ${dot}`} style={{ width: 5, height: 5 }} />
                          ))}
                        </span>
                        <span className="rb-rating-number">{r.rating}</span>
                      </span>
                    ) : '\u{2014}'}
                  </span>
                  <span className="rb-list-tags">
                    {r.tags && r.tags.split(',').map(t => t.trim()).filter(t => t && t.toLowerCase() !== 'make ahead').map(t => (
                      <span key={t} className={`rb-tag ${tagClass(t)}`}>{t}</span>
                    ))}
                  </span>
                  {r.added_by && (
                    <span className="rb-attribution">{r.added_by}</span>
                  )}
                  <span className="rb-list-date">{formatDate(r.created_at)}</span>
                  <span className="rb-list-cooks">{r.cook_count}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ============================================================= */}
      {/* Detail modal                                                   */}
      {/* ============================================================= */}
      {selectedRecipe && (
        <div className="rb-modal-overlay active" onClick={e => { if (e.target === e.currentTarget) closeDetail() }}>
          <div className="rb-modal">
            <button className="rb-modal-close" onClick={closeDetail}>&times;</button>

            {/* Hero — carousel of recipe photo + all cook log photos */}
            {(() => {
              const allPhotos: string[] = []
              if (selectedRecipe.image_filename && detailPhotoUrl) allPhotos.push(detailPhotoUrl)
              for (const log of selectedRecipe.cook_logs) {
                for (const fn of (log.photo_filenames || [])) {
                  allPhotos.push(getCookLogPhotoUrl(fn))
                }
              }
              if (allPhotos.length === 0) {
                return (
                  <div className="rb-modal-hero">
                    <div className="rb-modal-hero-placeholder" style={{ background: recipeGradient(selectedRecipe.name) }}>
                      {recipeEmoji(selectedRecipe.tags)}
                    </div>
                  </div>
                )
              }
              return (
                <div className="rb-modal-hero rb-carousel" data-count={allPhotos.length}>
                  <div className="rb-carousel-track" style={{ transform: `translateX(-${(Math.min(heroSlide, allPhotos.length - 1)) * 100}%)` }}>
                    {allPhotos.map((url) => (
                      <img key={url} src={url} alt={selectedRecipe.name} className="rb-carousel-slide img-fade"
                        onLoad={e => (e.target as HTMLImageElement).classList.add('loaded')}
                        onError={e => { (e.target as HTMLImageElement).style.background = recipeGradient(selectedRecipe.name); (e.target as HTMLImageElement).src = '' }} />
                    ))}
                  </div>
                  {allPhotos.length > 1 && (
                    <>
                      <button className="rb-carousel-btn prev" onClick={(e) => { e.stopPropagation(); setHeroSlide(s => (s - 1 + allPhotos.length) % allPhotos.length) }}>{'\u2039'}</button>
                      <button className="rb-carousel-btn next" onClick={(e) => { e.stopPropagation(); setHeroSlide(s => (s + 1) % allPhotos.length) }}>{'\u203A'}</button>
                      <div className="rb-carousel-dots">
                        {allPhotos.map((_, i) => (
                          <span key={i} className={`rb-carousel-dot${Math.min(heroSlide, allPhotos.length - 1) === i ? ' active' : ''}`} onClick={(e) => { e.stopPropagation(); setHeroSlide(i) }} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )
            })()}

            {/* Header */}
            <div className="rb-modal-header">
              <div className="rb-modal-title">{selectedRecipe.name}</div>
              {selectedRecipe.added_by && (
                <span className="rb-attribution detail">
                  <span className="rb-avatar">{selectedRecipe.added_by[0].toUpperCase()}</span>
                  {selectedRecipe.added_by}
                </span>
              )}
              <div className="rb-modal-subtitle">
                {selectedRecipe.rating != null && (
                  <span className="rb-rating-dots" style={{ marginBottom: 0 }}>
                    <span className="rb-rating-dot-row">
                      {ratingToDots(selectedRecipe.rating).map((dot, i) => (
                        <span key={i} className={`rb-rating-dot ${dot}`} style={{ width: 7, height: 7 }} />
                      ))}
                    </span>
                    <span className="rb-rating-number">{selectedRecipe.rating}/10</span>
                  </span>
                )}
                {selectedRecipe.source_url && (
                  <a href={selectedRecipe.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-indigo)', fontSize: '0.82rem', textDecoration: 'none' }}>
                    View Source
                  </a>
                )}
                {selectedRecipe.servings != null && <span>{selectedRecipe.servings} servings</span>}
                {selectedRecipe.feeds != null && <span>Feeds {selectedRecipe.feeds}</span>}
                {selectedRecipe.prep_ahead && <span className="rb-prep-badge">Make Ahead</span>}
              </div>
            </div>

            {/* Tabs */}
            <div className="rb-tabs">
              <button className={`rb-tab${activeTab === 'recipe' ? ' active' : ''}`} onClick={() => setActiveTab('recipe')}>Recipe</button>
              {isAuthenticated && (
                <button className={`rb-tab${activeTab === 'cooklog' ? ' active' : ''}`} onClick={() => setActiveTab('cooklog')}>
                  Cook Log ({selectedRecipe.cook_logs.length})
                </button>
              )}
            </div>

            {/* Recipe tab — split layout */}
            <div className={`rb-tab-content${activeTab === 'recipe' ? ' active' : ''}`}>
              <div className="rb-recipe-layout">
                {/* Ingredients sidebar with checkboxes + inline scale */}
                {selectedRecipe.ingredients.length > 0 && (
                  <div className="rb-ingredients-panel" style={{ background: 'none', border: 'none', padding: 0, margin: 0 }}>
                    <div className="rb-ingredients-header">
                      <div className="rb-ingredients-title-row">
                        <div className="rb-ingredients-panel-title">Ingredients</div>
                        {selectedRecipe.ingredients.some(i => i.original_unit) && (
                          <div className="rb-unit-toggle">
                            <button
                              className={`rb-unit-opt${useMetric ? ' active' : ''}`}
                              onClick={() => setUseMetric(true)}
                            >
                              metric
                            </button>
                            <button
                              className={`rb-unit-opt${!useMetric ? ' active' : ''}`}
                              onClick={() => setUseMetric(false)}
                            >
                              original
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="rb-scale-inline">
                        <input
                          type="number"
                          className="rb-scale-input"
                          min={0.5}
                          step={0.5}
                          value={scaleServings}
                          onChange={e => handleScaleChange(parseFloat(e.target.value) || 0)}
                          title="Scale servings"
                        />
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>servings</span>
                        {selectedRecipe.servings && (
                          <div className="rb-scale-presets">
                            {[0.5, 1, 2, 3].map(mult => {
                              const target = selectedRecipe.servings! * mult
                              return (
                                <button
                                  key={mult}
                                  className={`rb-scale-preset${scaleServings === target ? ' active' : ''}`}
                                  onClick={() => handleScaleChange(target)}
                                >
                                  {mult}x
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    {Array.from((scaledIngs && groupedScaledIngs ? groupedScaledIngs : groupedIngredients).entries() as IterableIterator<[string, any[]]>).map(([cat, ings]) => (
                      <div key={cat} className="rb-ingredient-group">
                        {cat !== 'Uncategorized' && <div className="rb-ingredient-group-title">{cat}</div>}
                        {ings.map((ing: any, idx: number) => {
                          const globalIdx = scaledIngs
                            ? selectedRecipe.ingredients.findIndex(orig => orig.name === ing.name)
                            : selectedRecipe.ingredients.indexOf(ing)
                          const scaleFactor = selectedRecipe.servings && scaleServings > 0 ? scaleServings / selectedRecipe.servings : 1
                          return (
                            <div
                              key={idx}
                              className={`rb-ingredient-item${ing.exotic ? ' exotic' : ''}${checkedIngs.has(globalIdx) ? ' checked' : ''}`}
                              onClick={() => toggleIngredient(globalIdx)}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className={`rb-ing-check${checkedIngs.has(globalIdx) ? ' checked' : ''}`} />
                              <span className="rb-ingredient-amount">
                                {!useMetric && ing.original_unit
                                  ? scaleOriginalUnit(ing.original_unit, scaleFactor)
                                  : ing.amount != null ? `${ing.amount} ${ing.unit || ''}`.trim() : ''}
                              </span>
                              <span className="rb-ingredient-name">
                                {ing.exotic && <span className="rb-exotic-star" title="Specialty ingredient">{'\u{2B50}'}</span>}
                                {ing.name}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}

                {/* Instructions main */}
                <div>
                  <div className="rb-ingredients-panel-title">Instructions</div>
                  <div className="rb-instructions">
                    {parseInstructions(selectedRecipe.instructions).map((block, i) => {
                      if (block.type === 'divider') {
                        return (
                          <div key={i} className="rb-step-divider">
                            {block.label && <span className="rb-step-divider-label">{block.label}</span>}
                          </div>
                        )
                      }
                      if (block.type === 'step') {
                        return (
                          <div key={i} className="rb-step">
                            <div className="rb-step-number">{block.number}</div>
                            <div className="rb-step-content">{highlightMeasurements(block.content)}</div>
                          </div>
                        )
                      }
                      return <div key={i} className="rb-step-text">{highlightMeasurements(block.content)}</div>
                    })}
                  </div>

                  {/* Notes */}
                  {isAuthenticated && selectedRecipe.notes && (
                    <div className="rb-notes-block">
                      <div className="rb-notes-block-title">Notes</div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{selectedRecipe.notes}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Cook Log tab */}
            <div className={`rb-tab-content${activeTab === 'cooklog' ? ' active' : ''}`}>
              <div style={{ marginBottom: 'var(--space-md)' }}>
                <button className="rb-cooklog-add-btn" onClick={() => { setShowCookLogForm(true); setCookLogDate(todayISO()) }}>
                  + Log a Cook
                </button>
              </div>

              {/* Cook log form */}
              {showCookLogForm && (
                <div className="rb-cook-log-entry" style={{ marginBottom: 'var(--space-md)' }}>
                  <div className="rb-form-row-3" style={{ marginBottom: 'var(--space-sm)' }}>
                    <div className="rb-form-group" style={{ marginBottom: 0 }}>
                      <label className="rb-form-label">Date</label>
                      <input type="date" className="rb-form-input" value={cookLogDate} onChange={e => setCookLogDate(e.target.value)} />
                    </div>
                    <div className="rb-form-group" style={{ marginBottom: 0 }}>
                      <label className="rb-form-label">Guests</label>
                      <input type="number" className="rb-form-input" placeholder="e.g., 4" value={cookLogGuests} onChange={e => setCookLogGuests(e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                      <button className="btn btn-primary btn-sm" onClick={handleAddCookLog} disabled={cookLogSaving}>{cookLogSaving ? 'Saving...' : 'Save'}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowCookLogForm(false)}>Cancel</button>
                    </div>
                  </div>
                  <div className="rb-form-group" style={{ marginBottom: 0, marginTop: 'var(--space-sm)' }}>
                    <label className="rb-form-label">Notes</label>
                    <input type="text" className="rb-form-input" placeholder="How did it go?" value={cookLogNotes} onChange={e => setCookLogNotes(e.target.value)} />
                  </div>
                  <div className="rb-form-row" style={{ marginTop: 'var(--space-sm)' }}>
                    <div className="rb-form-group" style={{ marginBottom: 0 }}>
                      <label className="rb-form-label">Rating</label>
                      <select className="rb-form-input" value={cookLogRating} onChange={e => setCookLogRating(e.target.value)}>
                        <option value="">No rating</option>
                        {[10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map(v => (
                          <option key={v} value={v}>{v}/10</option>
                        ))}
                      </select>
                    </div>
                    <div className="rb-form-group" style={{ marginBottom: 0 }}>
                      <label className="rb-form-label">Rating Comment (optional)</label>
                      <input type="text" className="rb-form-input" placeholder="e.g., Great but needs more sauce" value={cookLogRatingComment} onChange={e => setCookLogRatingComment(e.target.value)} />
                    </div>
                  </div>
                  <div className="rb-form-group" style={{ marginBottom: 0, marginTop: 'var(--space-sm)' }}>
                    <label className="rb-form-label">Photos</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        ref={cookLogPhotoRef}
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files) setCookLogPhotos(prev => [...prev, ...Array.from(e.target.files!)])
                          e.target.value = ''
                        }}
                      />
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => cookLogPhotoRef.current?.click()}>
                        📷 Add Photos
                      </button>
                      {cookLogPhotos.map((f, i) => (
                        <span key={i} className="rb-cooklog-photo-badge">
                          {f.name.slice(0, 15)}{f.name.length > 15 ? '...' : ''}
                          <button onClick={() => setCookLogPhotos(prev => prev.filter((_, j) => j !== i))}>&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Cook log entries */}
              {selectedRecipe.cook_logs.length === 0 && !showCookLogForm ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-lg)', color: 'var(--text-muted)' }}>
                  No cook logs yet. Log your first cook!
                </div>
              ) : (
                <div className="rb-cooklog-timeline">
                  {[...selectedRecipe.cook_logs].reverse().map(log => (
                    <div key={log.id} className="rb-cooklog-card">
                      <div className="rb-cooklog-card-header">
                        <CookLogCard
                          log={log}
                          showRecipeName={false}
                          currentUsername={currentUsername}
                          isAdmin={isAdmin}
                          onUpdate={(updated) => {
                            setSelectedRecipe(prev => prev ? {
                              ...prev,
                              cook_logs: prev.cook_logs.map(l => l.id === updated.id ? updated : l),
                            } : prev)
                          }}
                        />
                        {/* Edit button in card header */}
                        {isAuthenticated && (isAdmin || log.cooked_by === currentUsername) && editingCookLogId !== log.id && (
                          <button className="rb-cooklog-edit-btn" onClick={() => startEditCookLog(log)} title="Edit cook log">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                          </button>
                        )}
                      </div>
                      {/* Inline edit form */}
                      {editingCookLogId === log.id && (
                        <div className="rb-cook-log-edit">
                          <div className="rb-form-row-3" style={{ marginBottom: 'var(--space-sm)' }}>
                            <div className="rb-form-group" style={{ marginBottom: 0 }}>
                              <label className="rb-form-label">Date</label>
                              <input type="date" className="rb-form-input" value={editCookLogDate} onChange={e => setEditCookLogDate(e.target.value)} />
                            </div>
                            <div className="rb-form-group" style={{ marginBottom: 0 }}>
                              <label className="rb-form-label">Guests</label>
                              <input type="number" className="rb-form-input" placeholder="e.g., 4" value={editCookLogGuests} onChange={e => setEditCookLogGuests(e.target.value)} />
                            </div>
                          </div>
                          <div className="rb-form-group" style={{ marginBottom: 0, marginTop: 'var(--space-sm)' }}>
                            <label className="rb-form-label">Notes</label>
                            <input type="text" className="rb-form-input" placeholder="How did it go?" value={editCookLogNotes} onChange={e => setEditCookLogNotes(e.target.value)} />
                          </div>
                          <div className="rb-form-row" style={{ marginTop: 'var(--space-sm)' }}>
                            <div className="rb-form-group" style={{ marginBottom: 0 }}>
                              <label className="rb-form-label">Rating</label>
                              <select className="rb-form-input" value={editCookLogRating} onChange={e => setEditCookLogRating(e.target.value)}>
                                <option value="">No rating</option>
                                {[10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map(v => (
                                  <option key={v} value={v}>{v}/10</option>
                                ))}
                              </select>
                            </div>
                            <div className="rb-form-group" style={{ marginBottom: 0 }}>
                              <label className="rb-form-label">Rating Comment</label>
                              <input type="text" className="rb-form-input" placeholder="e.g., Great but needs more sauce" value={editCookLogRatingComment} onChange={e => setEditCookLogRatingComment(e.target.value)} />
                            </div>
                          </div>
                          {/* Existing photos with delete */}
                          {log.photo_filenames.length > 0 && (
                            <div style={{ marginTop: 'var(--space-sm)' }}>
                              <label className="rb-form-label">Photos</label>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {log.photo_filenames.map(fn => (
                                  <div key={fn} style={{ position: 'relative' }}>
                                    <img src={getCookLogPhotoUrl(fn)} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} />
                                    <button
                                      className="rb-remove-btn"
                                      style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, fontSize: '0.7rem' }}
                                      onClick={async () => {
                                        if (!selectedRecipe) return
                                        try {
                                          await deleteCookLogPhoto(selectedRecipe.id, log.id, fn)
                                          await openDetail(selectedRecipe.id)
                                        } catch { /* ignore */ }
                                      }}
                                    >&times;</button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Add photo */}
                          <div style={{ marginTop: 'var(--space-sm)', display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              ref={editCookLogPhotoRef}
                              type="file"
                              accept="image/*"
                              style={{ display: 'none' }}
                              onChange={async e => {
                                const file = e.target.files?.[0]
                                if (!file || !selectedRecipe) return
                                try {
                                  await uploadCookLogPhoto(selectedRecipe.id, log.id, file)
                                  // Refresh recipe data without changing tab
                                  const refreshed = await getRecipe(selectedRecipe.id)
                                  setSelectedRecipe(refreshed)
                                } catch { /* ignore */ }
                                e.target.value = ''
                              }}
                            />
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => editCookLogPhotoRef.current?.click()}>
                              Add Photo
                            </button>
                          </div>
                          {/* Save / Cancel / Delete */}
                          <div style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button className="btn btn-primary btn-sm" onClick={handleSaveEditCookLog} disabled={editCookLogSaving}>{editCookLogSaving ? 'Saving...' : 'Save'}</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditingCookLogId(null)}>Cancel</button>
                            <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => handleDeleteCookLog(log.id)}>Delete</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>


            {/* Actions */}
            {isAuthenticated && (
              <div className="rb-modal-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  title="Add to Shopping List"
                  onClick={() => {
                    const scale = selectedRecipe.servings && scaleServings > 0
                      ? scaleServings / selectedRecipe.servings
                      : 1.0
                    openShoppingPicker(selectedRecipe.id, selectedRecipe.name, scale, useMetric)
                  }}
                >
                  {'\u{1F6D2}'} Add to Shopping List
                </button>
                {(isAdmin || selectedRecipe?.added_by === currentUsername) && (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => { closeDetail(); openEditModal(selectedRecipe) }}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selectedRecipe.id)}>Delete</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================= */}
      {/* Add/Edit modal (auth only)                                     */}
      {/* ============================================================= */}
      {isAuthenticated && showAddModal && (
        <div className="rb-modal-overlay active" onClick={e => { if (e.target === e.currentTarget) { setShowAddModal(false); resetForm() } }}>
          <div className="rb-modal" style={{ maxWidth: 800 }}>
            <button className="rb-modal-close" onClick={() => { setShowAddModal(false); resetForm() }}>&times;</button>

            <div style={{ padding: 'var(--space-lg)', paddingBottom: 0 }}>
              <div className="rb-modal-title">{editingRecipe ? 'Edit Recipe' : 'Add Recipe'}</div>
            </div>

            {/* Mode toggle (only for new recipes) */}
            {!editingRecipe && (
              <div className="rb-add-mode-toggle">
                <button className={`rb-add-mode-btn${addMode === 'url' ? ' active' : ''}`} onClick={() => setAddMode('url')}>
                  Import from URL
                </button>
                <button className={`rb-add-mode-btn${addMode === 'text' ? ' active' : ''}`} onClick={() => setAddMode('text')}>
                  From Text
                </button>
                <button className={`rb-add-mode-btn${addMode === 'manual' ? ' active' : ''}`} onClick={() => setAddMode('manual')}>
                  Manual Entry
                </button>
              </div>
            )}

            {/* URL Import mode */}
            {addMode === 'url' && !editingRecipe && (
              <div className="rb-form-section">
                <div className="rb-form-group">
                  <label className="rb-form-label">Recipe URL</label>
                  <div className="rb-url-import">
                    <input
                      type="text"
                      className="rb-form-input"
                      placeholder="https://youtube.com/watch?v=... or recipe website URL"
                      value={importUrl}
                      onChange={e => setImportUrl(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleImport() }}
                    />
                    <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                      {importing ? 'Importing...' : 'Import'}
                    </button>
                  </div>
                  <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Supports YouTube videos and recipe websites. AI will extract the recipe structure.
                  </div>
                </div>
                <div className="rb-form-group">
                  <label className="rb-form-label">Instructions for AI (optional)</label>
                  <textarea
                    className="rb-form-input"
                    rows={3}
                    placeholder="e.g. Halve the amounts, convert to metric, skip the optional garnish..."
                    value={urlInstructions}
                    onChange={e => setUrlInstructions(e.target.value)}
                  />
                </div>
                {importing && !importError && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-md)', padding: 'var(--space-lg)' }}>
                    <div className="rb-spinner" />
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Extracting recipe...</span>
                  </div>
                )}
                {importError && (
                  <div className="rb-form-group" style={{ marginTop: 'var(--space-md)' }}>
                    <div className="rb-import-error">{importError}</div>
                    <label className="rb-form-label" style={{ marginTop: 'var(--space-sm)' }}>Paste Recipe Text</label>
                    <textarea
                      className="rb-form-input"
                      rows={10}
                      placeholder="Copy the recipe from the website and paste it here — ingredients, instructions, everything. AI will parse it."
                      value={pasteText}
                      onChange={e => setPasteText(e.target.value)}
                    />
                    <button
                      className="btn btn-primary"
                      style={{ marginTop: 'var(--space-sm)', alignSelf: 'flex-start' }}
                      onClick={handlePasteImport}
                      disabled={importing || !pasteText.trim()}
                    >
                      {importing ? 'Parsing...' : 'Parse Pasted Text'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* From Text mode */}
            {addMode === 'text' && !editingRecipe && (
              <div className="rb-form-section">
                <div className="rb-form-group">
                  <label className="rb-form-label">Recipe Text</label>
                  <textarea
                    className="rb-form-input"
                    rows={10}
                    placeholder="Paste your recipe here — ingredients, instructions, everything. AI will parse it into a structured recipe."
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                  />
                </div>
                <div className="rb-form-group">
                  <label className="rb-form-label">Instructions for AI (optional)</label>
                  <textarea
                    className="rb-form-input"
                    rows={3}
                    placeholder="e.g. Halve the amounts, convert to metric, skip the optional garnish..."
                    value={textInstructions}
                    onChange={e => setTextInstructions(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={handleTextParse}
                  disabled={importing || !pasteText.trim()}
                >
                  {importing ? 'Parsing...' : 'Parse Recipe'}
                </button>
                {importing && !importError && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-md)', padding: 'var(--space-lg)' }}>
                    <div className="rb-spinner" />
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Parsing recipe...</span>
                  </div>
                )}
                {importError && (
                  <div className="rb-import-error" style={{ marginTop: 'var(--space-sm)' }}>{importError}</div>
                )}
              </div>
            )}

            {/* Manual entry mode */}
            {(addMode === 'manual' || editingRecipe) && (
              <div className="rb-form-section">
                <div className="rb-form-group">
                  <label className="rb-form-label">Recipe Name</label>
                  <input type="text" className="rb-form-input" placeholder="e.g., Cola Braised Ribs" value={formName} onChange={e => setFormName(e.target.value)} />
                </div>

                <div className="rb-form-row">
                  <div className="rb-form-group">
                    <label className="rb-form-label">Source URL (optional)</label>
                    <input type="text" className="rb-form-input" placeholder="https://..." value={formSourceUrl} onChange={e => setFormSourceUrl(e.target.value)} />
                  </div>
                  <div className="rb-form-row">
                    <div className="rb-form-group">
                      <label className="rb-form-label">Servings (yield)</label>
                      <input type="number" className="rb-form-input" min={1} placeholder="e.g., 2 loaves" value={formServings} onChange={e => setFormServings(e.target.value)} />
                    </div>
                    <div className="rb-form-group">
                      <label className="rb-form-label">Feeds</label>
                      <input type="number" className="rb-form-input" min={1} placeholder="e.g., 12 people" value={formFeeds} onChange={e => setFormFeeds(e.target.value)} />
                    </div>
                  </div>
                </div>

                <div className="rb-form-group">
                  <label className="rb-form-label">Instructions</label>
                  <textarea className="rb-form-input" placeholder="Step-by-step recipe instructions..." value={formInstructions} onChange={e => setFormInstructions(e.target.value)} />
                </div>

                <div className="rb-form-group">
                  <label className="rb-form-label">Notes (optional)</label>
                  <textarea className="rb-form-input" style={{ minHeight: 80 }} placeholder="Tips, lessons learned, things to try next time..." value={formNotes} onChange={e => setFormNotes(e.target.value)} />
                </div>

                <div className="rb-form-group">
                  <label className="rb-form-label">Tags</label>
                  <input type="text" className="rb-form-input" placeholder="American, Dinner, Make Ahead" value={formTags} onChange={e => setFormTags(e.target.value)} />
                </div>

                <div className="rb-form-group">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                    <div
                      className={`rb-toggle-switch${formPrepAhead ? ' on' : ''}`}
                      onClick={() => setFormPrepAhead(prev => !prev)}
                    />
                    <span className="rb-toggle-label">Needs advance prep (make day before)</span>
                  </div>
                </div>

                {/* Ingredients */}
                <div className="rb-form-group">
                  <label className="rb-form-label">Ingredients</label>
                  <div className="rb-ingredient-form-header">
                    <span>Name</span>
                    <span>Grams</span>
                    <span>Original</span>
                    <span>Category</span>
                    <span title="Specialty ingredient">{'\u{2B50}'}</span>
                    <span></span>
                  </div>
                  {formIngredients.map((ing, idx) => (
                    <div key={idx} className="rb-ingredient-row">
                      <input
                        type="text"
                        placeholder="e.g., Short ribs"
                        value={ing.name}
                        onChange={e => updateIngredient(idx, 'name', e.target.value)}
                      />
                      <input
                        type="number"
                        placeholder="250"
                        value={ing.amount ?? ''}
                        onChange={e => updateIngredient(idx, 'amount', e.target.value ? parseFloat(e.target.value) : null)}
                      />
                      <input
                        type="text"
                        placeholder="2 tbsp"
                        value={ing.original_unit || ''}
                        onChange={e => updateIngredient(idx, 'original_unit', e.target.value || null)}
                      />
                      <input
                        type="text"
                        placeholder="Meat"
                        value={ing.category || ''}
                        onChange={e => updateIngredient(idx, 'category', e.target.value || null)}
                      />
                      <input
                        type="checkbox"
                        checked={ing.exotic || false}
                        onChange={e => updateIngredient(idx, 'exotic', e.target.checked)}
                        title="Specialty ingredient"
                        style={{ width: 'auto', cursor: 'pointer' }}
                      />
                      <button className="rb-remove-btn" onClick={() => removeIngredientRow(idx)}>&times;</button>
                    </div>
                  ))}
                  <button className="rb-add-ingredient-btn" onClick={addIngredientRow}>+ Add Ingredient</button>
                </div>

                {/* Photo */}
                <div className="rb-form-group">
                  <label className="rb-form-label">Photo (optional)</label>
                  {editingRecipe && editPhotoUrl && !removeExistingPhoto && !photoFile ? (
                    <div className="rb-photo-preview">
                      <img src={editPhotoUrl} alt="Current photo" className="rb-photo-preview-img" />
                      <button
                        type="button"
                        className="rb-photo-delete-btn"
                        title="Remove photo"
                        onClick={() => setRemoveExistingPhoto(true)}
                      >
                        &times;
                      </button>
                    </div>
                  ) : (
                    <label className="rb-photo-dropzone">
                      <div style={{ fontSize: '2rem', marginBottom: '8px' }}>{'\u{1F4F7}'}</div>
                      <div>{photoFile ? photoFile.name : 'Click or drag to upload a photo'}</div>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={e => setPhotoFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  )}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="rb-modal-footer">
              <button className="btn btn-ghost" onClick={() => { setShowAddModal(false); resetForm() }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={!formName.trim()}>
                {editingRecipe ? 'Update Recipe' : 'Save Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {/* Shopping List Ingredient Picker */}
      {shoppingPicker && (
        <div className="photo-modal-backdrop" onClick={() => setShoppingPicker(null)}>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-medium)',
            borderRadius: 'var(--radius-lg)', padding: '20px', maxWidth: 480, width: '90%',
            maxHeight: '80vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>Add to Shopping List</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{shoppingPicker.recipeName}</div>
              </div>
              <button onClick={() => setShoppingPicker(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              <span>{shoppingPicker.ingredients.filter(i => i.selected).length} of {shoppingPicker.ingredients.length} selected</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setShoppingPicker(p => p ? { ...p, ingredients: p.ingredients.map(i => ({ ...i, selected: true })) } : null)} style={{ background: 'none', border: 'none', color: 'var(--accent-indigo)', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}>Select all</button>
                <button onClick={() => setShoppingPicker(p => p ? { ...p, ingredients: p.ingredients.map(i => ({ ...i, selected: false })) } : null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}>Clear all</button>
              </div>
            </div>
            <div style={{ overflow: 'auto', flex: 1, marginBottom: 16 }}>
              {shoppingPicker.ingredients.map((ing, i) => (
                <div key={i} onClick={() => setShoppingPicker(p => {
                  if (!p) return null
                  const next = [...p.ingredients]
                  next[i] = { ...next[i], selected: !next[i].selected }
                  return { ...p, ingredients: next }
                })} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px',
                  borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer',
                  opacity: ing.selected ? 1 : 0.45,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: 5,
                    border: `2px solid ${ing.selected ? 'var(--accent-emerald)' : 'var(--border-medium)'}`,
                    background: ing.selected ? 'var(--accent-emerald)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.65rem', color: '#fff', flexShrink: 0, transition: 'all 0.15s',
                  }}>
                    {ing.selected && '✓'}
                  </div>
                  <span style={{ flex: 1, fontSize: '0.82rem', fontWeight: ing.selected ? 500 : 400, textDecoration: ing.selected ? 'none' : 'line-through' }}>{ing.name}</span>
                  {ing.amount != null && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                      {ing.amount}{ing.unit ? ` ${ing.unit}` : ''}
                    </span>
                  )}
                  {ing.exotic && <span style={{ fontSize: '0.65rem', color: 'var(--accent-amber)', flexShrink: 0 }} title="Specialty item">✨</span>}
                </div>
              ))}
            </div>
            <button onClick={handleConfirmShoppingList} disabled={shoppingPicker.ingredients.filter(i => i.selected).length === 0 || shoppingAdding || shoppingClassifying} style={{
              width: '100%', padding: 10, border: 'none', borderRadius: 'var(--radius-md)',
              background: 'var(--accent-indigo)', color: '#fff', fontFamily: 'var(--font-sans)',
              fontSize: '0.82rem', fontWeight: 600, cursor: (shoppingAdding || shoppingClassifying) ? 'wait' : 'pointer',
              opacity: (shoppingPicker.ingredients.filter(i => i.selected).length === 0 || shoppingAdding || shoppingClassifying) ? 0.4 : 1,
            }}>
              {shoppingClassifying ? 'Classifying ingredients...' : shoppingAdding ? 'Adding...' : `Add ${shoppingPicker.ingredients.filter(i => i.selected).length} items to Shopping List`}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-card)', backdropFilter: 'blur(12px)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          padding: '10px 20px', color: 'var(--text-primary)',
          fontSize: '0.82rem', fontWeight: 500, zIndex: 1000,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          {'\u{1F6D2}'} {toast}
        </div>
      )}
    </div>
  )
}
