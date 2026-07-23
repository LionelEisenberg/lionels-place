import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  recipeGradient, recipeEmoji, tagClass, parseInstructions,
  ratingToDots, relativeDate, scaleOriginalUnit,
} from './recipe-helpers'

describe('recipeGradient', () => {
  it('returns a CSS linear-gradient string', () => {
    const result = recipeGradient('Pasta Carbonara')
    expect(result).toMatch(/^linear-gradient\(135deg,/)
  })

  it('is deterministic — same name produces same gradient', () => {
    expect(recipeGradient('Tacos')).toBe(recipeGradient('Tacos'))
  })

  it('different names produce different gradients', () => {
    expect(recipeGradient('Tacos')).not.toBe(recipeGradient('Pizza'))
  })
})

describe('recipeEmoji', () => {
  it.each([
    ['Italian, Dinner', '🍝'],
    ['Japanese, Seafood', '🍣'],
    ['Dessert, Baking', '🍰'],
    ['Vegetarian, Quick', '🌿'],
  ])('recipeEmoji(%s) = %s', (tags, expected) => {
    expect(recipeEmoji(tags)).toBe(expected)
  })

  it('returns default chef emoji for null tags', () => {
    expect(recipeEmoji(null)).toBe('🧑‍🍳')
  })

  it('returns default for unrecognized tags', () => {
    expect(recipeEmoji('Unknown')).toBe('🧑‍🍳')
  })
})

describe('tagClass', () => {
  it.each([
    ['Italian', 'cuisine'],
    ['Breakfast', 'course'],
    ['Vegetarian', 'dietary'],
    ['Baking', 'method'],
    ['Unknown', ''],
  ])('tagClass(%s) = %s', (tag, expected) => {
    expect(tagClass(tag)).toBe(expected)
  })
})

describe('parseInstructions', () => {
  it('parses numbered steps', () => {
    const result = parseInstructions('1. Boil water\n2. Add pasta')
    expect(result).toEqual([
      { type: 'step', number: 1, content: 'Boil water' },
      { type: 'step', number: 2, content: 'Add pasta' },
    ])
  })

  it('parses labeled dividers', () => {
    const result = parseInstructions('--- Day 2 ---')
    expect(result).toEqual([{ type: 'divider', label: 'Day 2' }])
  })

  it('parses plain dividers', () => {
    const result = parseInstructions('---')
    expect(result).toEqual([{ type: 'divider', label: '' }])
  })

  it('collapses continuation lines into the previous step', () => {
    const result = parseInstructions('1. Start cooking\nstir occasionally\nuntil done')
    expect(result).toEqual([
      { type: 'step', number: 1, content: 'Start cooking stir occasionally until done' },
    ])
  })

  it('falls back to plain text', () => {
    const result = parseInstructions('Just a note about the recipe')
    expect(result).toEqual([{ type: 'text', content: 'Just a note about the recipe' }])
  })

  it('skips blank lines', () => {
    const result = parseInstructions('1. Step one\n\n2. Step two')
    expect(result).toHaveLength(2)
  })

  it('handles mixed content', () => {
    const result = parseInstructions('Preheat oven\n--- Filling ---\n1. Mix ingredients\n2. Pour into pan')
    expect(result).toEqual([
      { type: 'text', content: 'Preheat oven' },
      { type: 'divider', label: 'Filling' },
      { type: 'step', number: 1, content: 'Mix ingredients' },
      { type: 'step', number: 2, content: 'Pour into pan' },
    ])
  })
})

describe('ratingToDots', () => {
  it.each([
    [10, ['filled', 'filled', 'filled', 'filled', 'filled']],
    [0, ['empty', 'empty', 'empty', 'empty', 'empty']],
    [5, ['filled', 'filled', 'half', 'empty', 'empty']],
    [7, ['filled', 'filled', 'filled', 'half', 'empty']],
    [7.5, ['filled', 'filled', 'filled', 'half', 'empty']],
    [8, ['filled', 'filled', 'filled', 'filled', 'empty']],
  ])('ratingToDots(%i) = %j', (rating, expected) => {
    expect(ratingToDots(rating)).toEqual(expected)
  })
})

describe('relativeDate', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 2, 20)) }) // 2026-03-20
  afterEach(() => { vi.useRealTimers() })

  it('returns null for null input', () => {
    expect(relativeDate(null)).toBeNull()
  })

  it('returns null for invalid date', () => {
    expect(relativeDate('not-a-date')).toBeNull()
  })

  it('returns "today" for today', () => {
    expect(relativeDate('2026-03-20')).toBe('today')
  })

  it('returns "yesterday" for yesterday', () => {
    expect(relativeDate('2026-03-19')).toBe('yesterday')
  })

  it('returns "N days ago" for recent dates', () => {
    expect(relativeDate('2026-03-16')).toBe('4 days ago')
  })
})

describe('scaleOriginalUnit', () => {
  it('scales a whole number amount', () => {
    expect(scaleOriginalUnit('2 cups', 2)).toBe('4 cups')
  })

  it('scales a decimal amount', () => {
    expect(scaleOriginalUnit('1.5 tbsp', 2)).toBe('3 tbsp')
  })

  it('scales a fraction', () => {
    expect(scaleOriginalUnit('1/2 cup', 2)).toBe('1 cup')
  })

  it('scales a fraction to a decimal', () => {
    expect(scaleOriginalUnit('1/3 cup', 2)).toBe('0.7 cup')
  })

  it('returns integer when result is whole', () => {
    expect(scaleOriginalUnit('3 large', 2)).toBe('6 large')
  })

  it('preserves text without leading number', () => {
    expect(scaleOriginalUnit('to taste', 3)).toBe('to taste')
  })

  it('preserves text when no number prefix', () => {
    expect(scaleOriginalUnit('a pinch', 2)).toBe('a pinch')
  })

  it('handles 1x scale (no change)', () => {
    expect(scaleOriginalUnit('2 cups', 1)).toBe('2 cups')
  })

  it('handles half scale', () => {
    expect(scaleOriginalUnit('2 cups', 0.5)).toBe('1 cups')
  })

  it('handles 1/4 fraction scaled up', () => {
    expect(scaleOriginalUnit('1/4 tsp', 4)).toBe('1 tsp')
  })
})
