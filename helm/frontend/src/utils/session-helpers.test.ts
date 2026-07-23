import { describe, it, expect } from 'vitest'
import { formatDurationMin, activityColor, formatRange, activityEmoji } from './session-helpers'

describe('session-helpers', () => {
  it('formats durations', () => {
    expect(formatDurationMin(70)).toBe('1h10m')
    expect(formatDurationMin(21)).toBe('21m')
    expect(formatDurationMin(60)).toBe('1h')
    expect(formatDurationMin(null)).toBe('')
    expect(formatDurationMin(undefined)).toBe('')
  })

  it('maps activity colour with a fallback', () => {
    expect(activityColor('strength')).toBe('var(--accent-rose)')
    expect(activityColor('swim')).toBe('var(--accent-sky)')
    expect(activityColor('mystery')).toBe('var(--accent-indigo)')
  })

  it('formats a time range', () => {
    expect(formatRange('14:48', '15:58')).toBe('14:48–15:58')
    expect(formatRange(null, null)).toBe('')
    expect(formatRange('14:48', null)).toBe('14:48')
  })

  it('has an emoji per activity', () => {
    expect(activityEmoji('swim')).toBe('🏊')
    expect(activityEmoji('strength')).toBe('🏋️')
    expect(activityEmoji('stairs')).toBe('🪜')
    expect(activityEmoji('whatever')).toBe('💪')
  })
})
