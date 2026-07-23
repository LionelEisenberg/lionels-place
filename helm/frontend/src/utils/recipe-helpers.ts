/**
 * Recipe display helpers extracted from RecipeBank.tsx for testability.
 */
import { toLocalISO } from '../dates'

export function recipeGradient(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const h = Math.abs(hash % 360)
  return `linear-gradient(135deg, hsl(${h}, 40%, 15%) 0%, hsl(${(h + 30) % 360}, 50%, 25%) 50%, hsl(${(h + 60) % 360}, 35%, 12%) 100%)`
}

export const EMOJI_MAP: [string, string][] = [
  // Cuisines
  ['japanese', '🍣'], ['chinese', '🥡'], ['mexican', '🌮'], ['indian', '🍛'],
  ['italian', '🍝'], ['french', '🥐'], ['greek', '🫒'], ['korean', '🥘'],
  ['thai', '🍜'], ['american', '🍔'], ['mediterranean', '🫓'],
  // Courses
  ['dessert', '🍰'], ['breakfast', '🍳'], ['appetizer', '🥟'], ['soup', '🍲'],
  ['salad', '🥗'], ['sandwich', '🥪'], ['pizza', '🍕'], ['seafood', '🦐'],
  ['side dish', '🥦'], ['side', '🥦'], ['snack', '🥜'], ['drink', '🍹'],
  // Dietary
  ['vegetarian', '🌿'], ['vegan', '🌱'], ['gluten free', '🌾'], ['keto', '🥑'],
  ['dairy free', '🥛'], ['healthy', '💚'], ['comfort', '🧸'],
  // Methods
  ['baking', '🧁'], ['grilling', '🔥'], ['quick', '⚡'], ['make ahead', '🧊'],
]

export function recipeEmoji(tags: string | null): string {
  if (!tags) return '🧑‍🍳'
  const t = tags.toLowerCase()
  for (const [key, emoji] of EMOJI_MAP) {
    if (t.includes(key)) return emoji
  }
  return '🧑‍🍳'
}

export const TAG_STYLES: Record<string, string> = {
  american: 'cuisine', italian: 'cuisine', greek: 'cuisine', mexican: 'cuisine',
  indian: 'cuisine', japanese: 'cuisine', chinese: 'cuisine', french: 'cuisine',
  dinner: 'course', appetizer: 'course', lunch: 'course', breakfast: 'course',
  'side dish': 'course', side: 'course', snack: 'course', drink: 'course',
  vegetarian: 'dietary', vegan: 'dietary', 'gluten free': 'dietary', keto: 'dietary',
  'dairy free': 'dietary', healthy: 'dietary', comfort: 'dietary',
  baking: 'method', quick: 'method', 'make ahead': 'method', grilling: 'method',
}

export function tagClass(tag: string): string {
  return TAG_STYLES[tag.toLowerCase()] || ''
}

export type InstructionBlock =
  | { type: 'step'; number: number; content: string }
  | { type: 'divider'; label: string }
  | { type: 'text'; content: string }

export function parseInstructions(text: string): InstructionBlock[] {
  const lines = text.split('\n')
  const blocks: InstructionBlock[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()

    if (!line) { i++; continue }

    if (/^---\s*(.+?)\s*---$/.test(line)) {
      const label = line.replace(/^---\s*/, '').replace(/\s*---$/, '')
      blocks.push({ type: 'divider', label })
      i++
      continue
    }

    if (line === '---') {
      blocks.push({ type: 'divider', label: '' })
      i++
      continue
    }

    const stepMatch = line.match(/^(\d+)[.)]\s+(.+)/)
    if (stepMatch) {
      let content = stepMatch[2]
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim()
        if (!next || /^(\d+)[.)]\s/.test(next) || /^---/.test(next)) break
        content += ' ' + next
        i++
      }
      blocks.push({ type: 'step', number: parseInt(stepMatch[1]), content })
      i++
      continue
    }

    blocks.push({ type: 'text', content: line })
    i++
  }

  return blocks
}

/** Parse an ISO date or datetime string. Datetimes from the backend are UTC without a Z suffix. */
function parseISO(iso: string): Date {
  const raw = iso.includes('T') ? (iso.endsWith('Z') ? iso : iso + 'Z') : iso + 'T00:00:00'
  return new Date(raw)
}

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = parseISO(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ratingToDots(rating: number): ('filled' | 'half' | 'empty')[] {
  const scaled = rating / 2
  const dots: ('filled' | 'half' | 'empty')[] = []
  for (let i = 1; i <= 5; i++) {
    if (scaled >= i) dots.push('filled')
    else if (scaled >= i - 0.5) dots.push('half')
    else dots.push('empty')
  }
  return dots
}

export function relativeDate(iso: string | null): string | null {
  if (!iso) return null
  const d = parseISO(iso)
  if (isNaN(d.getTime())) return null
  const todayStr = toLocalISO(new Date())
  const dStr = toLocalISO(d)
  const diffDays = Math.round((new Date(todayStr).getTime() - new Date(dStr).getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 14) return 'last week'
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  if (diffDays < 60) return 'last month'
  return `${Math.floor(diffDays / 30)} months ago`
}

/**
 * Scale the leading number in an original_unit string (e.g. "2 cups" → "4 cups" at 2x).
 * Handles fractions like "1/2 cup". Returns the string unchanged if no leading number.
 */
export function scaleOriginalUnit(originalUnit: string, scaleFactor: number): string {
  return originalUnit.replace(/^([\d.]+(?:\/[\d.]+)?)/, (_, n) => {
    const parts = n.split('/')
    const num = parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : parseFloat(n)
    const scaled = Math.round(num * scaleFactor * 100) / 100
    return scaled % 1 === 0 ? scaled.toString() : scaled.toFixed(scaled < 10 ? 1 : 0)
  })
}
