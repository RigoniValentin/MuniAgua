import { describe, it, expect } from 'vitest';
import {
  applyPercentageAdjustmentMinor,
  computeAdjustment,
  impliedPercentage,
  isValidPercentage,
  roundHalfUp,
  toMajorUnits,
  toMinorUnits,
} from '../src/shared/money';

describe('money — toMinorUnits / toMajorUnits', () => {
  it('converts major to minor units', () => {
    expect(toMinorUnits(10_000)).toBe(1_000_000);
    expect(toMinorUnits(0.01)).toBe(1);
    expect(toMajorUnits(1_000_000)).toBe(10_000);
  });

  it('rounds to the nearest cent', () => {
    expect(toMinorUnits(1234.56)).toBe(123_456);
    expect(toMinorUnits(0.1)).toBe(10);
  });

  it('rejects non-finite amounts', () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow();
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('money — roundHalfUp', () => {
  it('rounds half away from zero', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
  });

  it('rounds negatives symmetrically (not toward +Infinity)', () => {
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-1.5)).toBe(-2);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });

  it('keeps integers untouched', () => {
    expect(roundHalfUp(7)).toBe(7);
    expect(roundHalfUp(-7)).toBe(-7);
  });
});

describe('money — applyPercentageAdjustmentMinor', () => {
  it('applies positive and negative percentages', () => {
    expect(applyPercentageAdjustmentMinor(1_000_000, 40)).toBe(400_000);
    expect(applyPercentageAdjustmentMinor(1_000_000, -50)).toBe(-500_000);
    expect(applyPercentageAdjustmentMinor(1_000_000, 0)).toBe(0);
  });

  it('rounds the adjustment to the cent', () => {
    // 333 * 10% = 33.3 → 33
    expect(applyPercentageAdjustmentMinor(333, 10)).toBe(33);
  });

  it('rejects invalid inputs', () => {
    expect(() => applyPercentageAdjustmentMinor(-1, 10)).toThrow();
    expect(() => applyPercentageAdjustmentMinor(1.5, 10)).toThrow();
    expect(() => applyPercentageAdjustmentMinor(100, 1.5)).toThrow();
  });
});

describe('money — computeAdjustment', () => {
  it('returns the adjustment and the final amount', () => {
    expect(computeAdjustment(1_000_000, -50)).toEqual({
      adjustmentMinor: -500_000,
      finalMinor: 500_000,
    });
  });

  it('clamps the final amount at 0', () => {
    expect(computeAdjustment(1_000_000, -100).finalMinor).toBe(0);
    expect(computeAdjustment(1_000_000, -150).finalMinor).toBe(0);
  });
});

describe('money — impliedPercentage', () => {
  it('computes the margin of an exact price against the base', () => {
    expect(impliedPercentage(1_000_000, 650_000)).toBe(-35);
    expect(impliedPercentage(1_000_000, 1_400_000)).toBe(40);
    expect(impliedPercentage(1_000_000, 1_000_000)).toBe(0);
  });

  it('rounds to the nearest integer', () => {
    expect(impliedPercentage(1_000_000, 333_333)).toBe(-67);
    expect(impliedPercentage(3, 2)).toBe(-33);
  });

  it('returns 0 when the base is 0 (no meaningful ratio)', () => {
    expect(impliedPercentage(0, 500)).toBe(0);
  });

  it('rejects invalid inputs', () => {
    expect(() => impliedPercentage(-1, 100)).toThrow();
    expect(() => impliedPercentage(100, 1.5)).toThrow();
  });
});

describe('money — isValidPercentage', () => {
  it('accepts percentages inside the allowed range', () => {
    expect(isValidPercentage(0)).toBe(true);
    expect(isValidPercentage(-100)).toBe(true);
    expect(isValidPercentage(1000)).toBe(true);
  });

  it('rejects out-of-range or non-integer percentages', () => {
    expect(isValidPercentage(-101)).toBe(false);
    expect(isValidPercentage(1001)).toBe(false);
    expect(isValidPercentage(1.5)).toBe(false);
  });
});
