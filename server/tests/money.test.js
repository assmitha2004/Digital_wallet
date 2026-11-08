import { describe, expect, it } from 'vitest';
import { formatPaise, rupeesToPaise, startOfTodayIST } from '../src/money.js';

describe('rupeesToPaise', () => {
  it.each([
    ['1', 100],
    ['250.5', 25050],
    ['250.50', 25050],
    ['0.01', 1],
    [' 99.99 ', 9999],
    [42, 4200],
  ])('%j -> %i paise', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each(['0', '0.00', '-5', '1.001', 'abc', '', '1e3', '01', '.5', 0.1 + 0.2, null, undefined])('rejects %j', (input) => {
    expect(rupeesToPaise(input)).toBeNull();
  });
});

describe('formatPaise', () => {
  it('formats integers as rupees with two decimals', () => {
    expect(formatPaise(25050)).toBe('250.50');
    expect(formatPaise(7)).toBe('0.07');
    expect(formatPaise(-150)).toBe('-1.50');
  });
});

describe('startOfTodayIST', () => {
  it('returns 18:30 UTC of the previous day', () => {
    expect(startOfTodayIST(new Date('2026-11-08T10:00:00Z')).toISOString()).toBe('2026-11-07T18:30:00.000Z');
  });
  it('rolls over at midnight India time, not UTC', () => {
    expect(startOfTodayIST(new Date('2026-11-08T19:00:00Z')).toISOString()).toBe('2026-11-08T18:30:00.000Z');
  });
});
