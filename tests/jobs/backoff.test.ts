import { describe, expect, it } from 'vitest';
import { backoffDelayMs, shouldRetry, MAX_DELAY_MS } from '@/lib/jobs/retry';

describe('backoffDelayMs', () => {
  it('attempt 0 stays within [base, base + base)', () => {
    const base = 1000;
    const delay = backoffDelayMs(0, base);
    expect(delay).toBeGreaterThanOrEqual(base);
    expect(delay).toBeLessThan(base + base);
  });

  it('lower bound is base * 2^attempt for attempts 0..8', () => {
    const base = 1000;
    for (let attempt = 0; attempt <= 8; attempt++) {
      const delay = backoffDelayMs(attempt, base);
      expect(delay).toBeGreaterThanOrEqual(base * 2 ** attempt);
    }
  });

  it('upper bound is base * 2^attempt + base for attempts 0..8', () => {
    const base = 1000;
    for (let attempt = 0; attempt <= 8; attempt++) {
      const delay = backoffDelayMs(attempt, base);
      expect(delay).toBeLessThanOrEqual(base * 2 ** attempt + base);
    }
  });

  it('honors a custom base', () => {
    const base = 500;
    const delay = backoffDelayMs(2, base); // 500 * 4 = 2000 + jitter(0..500)
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it('uses default base of 1000ms when omitted', () => {
    const delay = backoffDelayMs(0);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
  });

  it('caps at MAX_DELAY_MS for very large attempts', () => {
    expect(backoffDelayMs(30)).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(backoffDelayMs(100)).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(backoffDelayMs(1000)).toBeLessThanOrEqual(MAX_DELAY_MS);
  });

  it('MAX_DELAY_MS equals 15 minutes', () => {
    expect(MAX_DELAY_MS).toBe(15 * 60 * 1000);
  });

  it('clamps negative attempts to 0', () => {
    const delay = backoffDelayMs(-3);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
  });

  it('jitter actually varies (not a constant)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      seen.add(backoffDelayMs(0, 10_000));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('growth is roughly exponential across attempts', () => {
    const base = 1000;
    const mins: number[] = [];
    for (let attempt = 0; attempt <= 5; attempt++) {
      mins.push(backoffDelayMs(attempt, base));
    }
    // each attempt's floor should double: min(delay_attempt) >= base*2^attempt
    for (let attempt = 0; attempt <= 5; attempt++) {
      expect(mins[attempt]).toBeGreaterThanOrEqual(base * 2 ** attempt);
    }
  });
});

describe('shouldRetry', () => {
  it('allows retries while attempts < maxAttempts', () => {
    expect(shouldRetry(0, 5)).toBe(true);
    expect(shouldRetry(4, 5)).toBe(true);
  });

  it('blocks when attempts reaches maxAttempts', () => {
    expect(shouldRetry(5, 5)).toBe(false);
    expect(shouldRetry(6, 5)).toBe(false);
  });

  it('handles zero maxAttempts', () => {
    expect(shouldRetry(0, 0)).toBe(false);
  });
});
