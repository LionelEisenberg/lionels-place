import { describe, it, expect } from 'vitest';
import { computeRunningTotals } from './quick-add-helpers';
import type { MealItemData } from '../api';

const item = (over: Partial<MealItemData> = {}): MealItemData => ({
  name: 'X', quantity: '1', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
  ...over,
});

describe('computeRunningTotals', () => {
  it('returns all zeros for empty array', () => {
    expect(computeRunningTotals([])).toEqual({
      calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
    });
  });

  it('sums macros across items', () => {
    const items = [
      item({ calories: 280, protein_g: 53 }),
      item({ calories: 205, protein_g: 4, carbs_g: 45 }),
    ];
    expect(computeRunningTotals(items)).toEqual({
      calories: 485, protein_g: 57, carbs_g: 45, fat_g: 0, fiber_g: 0,
    });
  });
});
