import { describe, it, expect } from 'vitest';
import { proximityTier, countdownParts, formatDayLabel } from './important-dates-helpers';

describe('proximityTier', () => {
  it('maps day 0 (or negative) to today', () => {
    expect(proximityTier(0)).toBe('today');
    expect(proximityTier(-3)).toBe('today');
  });

  it('maps day 1 to tomorrow', () => {
    expect(proximityTier(1)).toBe('tomorrow');
  });

  it('maps 2..6 days to week', () => {
    expect(proximityTier(2)).toBe('week');
    expect(proximityTier(6)).toBe('week');
  });

  it('maps 7..30 days to soon', () => {
    expect(proximityTier(7)).toBe('soon');
    expect(proximityTier(30)).toBe('soon');
  });

  it('maps beyond 30 days to far', () => {
    expect(proximityTier(31)).toBe('far');
    expect(proximityTier(200)).toBe('far');
  });
});

describe('countdownParts', () => {
  it('celebrates today with a party emoji', () => {
    expect(countdownParts(0)).toEqual({ big: '🎉', small: 'today' });
  });

  it('uses the singular unit for one day', () => {
    expect(countdownParts(1)).toEqual({ big: '1', small: 'day' });
  });

  it('uses the plural unit for multiple days', () => {
    expect(countdownParts(4)).toEqual({ big: '4', small: 'days' });
    expect(countdownParts(99)).toEqual({ big: '99', small: 'days' });
  });

  it('collapses far-out dates to months to avoid 3-digit badges', () => {
    expect(countdownParts(100)).toEqual({ big: '3', small: 'months' });
    expect(countdownParts(120)).toEqual({ big: '4', small: 'months' });
  });
});

describe('formatDayLabel', () => {
  it('formats an ISO date as "Wkd · Mon D"', () => {
    // 2026-06-21 is a Sunday.
    expect(formatDayLabel('2026-06-21')).toBe('Sun · Jun 21');
  });

  it('does not slip a day regardless of local time (parsed at noon)', () => {
    // 2026-01-01 is a Thursday.
    expect(formatDayLabel('2026-01-01')).toBe('Thu · Jan 1');
  });

  it('returns empty string for empty or invalid input', () => {
    expect(formatDayLabel('')).toBe('');
    expect(formatDayLabel('not-a-date')).toBe('');
  });
});
