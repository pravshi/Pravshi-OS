/**
 * Unit tests: deterministic relevance tiers (contract §16.2).
 *
 * "exact match > prefix > trigram similarity. Score 0-1."
 * These pin the tier order, bounds, and determinism of the pure helpers in
 * ranking.ts, which the SQL score expression in query.ts mirrors.
 */
import { describe, expect, it } from 'vitest';
import {
  SCORE_EXACT,
  SCORE_PREFIX,
  SCORE_SUBSTRING,
  SCORE_TRIGRAM_MAX,
  SCORE_TRIGRAM_SCALE,
  TRIGRAM_SIMILARITY_THRESHOLD,
  classRank,
  classifyField,
  escapeLikePattern,
  scoreForClass,
} from '@/lib/search/ranking';

describe('relevance tiers', () => {
  it('orders exact > prefix > trigram > substring > none', () => {
    expect(SCORE_EXACT).toBe(1.0);
    expect(SCORE_PREFIX).toBeLessThan(SCORE_EXACT);
    expect(SCORE_TRIGRAM_MAX).toBeLessThan(SCORE_PREFIX);
    expect(SCORE_SUBSTRING).toBeLessThan(SCORE_TRIGRAM_MAX);
    expect(SCORE_SUBSTRING).toBeGreaterThan(0);
  });

  it('keeps every score inside [0, 1]', () => {
    const samples: number[] = [
      scoreForClass('exact'),
      scoreForClass('prefix'),
      scoreForClass('trigram', 0.3),
      scoreForClass('trigram', 0.99),
      scoreForClass('trigram', 1.5), // clamped
      scoreForClass('substring'),
      scoreForClass('none'),
    ];
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic: same inputs always give the same score', () => {
    for (let i = 0; i < 25; i++) {
      expect(scoreForClass('trigram', 0.7342)).toBe(scoreForClass('trigram', 0.7342));
      expect(classifyField('Acme Corp', 'acme')).toBe(classifyField('Acme Corp', 'acme'));
    }
  });
});

describe('classifyField', () => {
  it('is case-insensitive', () => {
    expect(classifyField('Acme Corp', 'ACME CORP')).toBe('exact');
    expect(classifyField('ACME', 'ac')).toBe('prefix');
  });

  it('classifies exact, prefix, substring, and none', () => {
    expect(classifyField('acme', 'acme')).toBe('exact');
    expect(classifyField('acme corp', 'acme')).toBe('prefix');
    expect(classifyField('the acme company', 'acme')).toBe('substring');
    expect(classifyField('globex', 'acme')).toBe('none');
  });
});

describe('scoreForClass', () => {
  it('scores exact and prefix at fixed tiers', () => {
    expect(scoreForClass('exact')).toBe(SCORE_EXACT);
    expect(scoreForClass('prefix')).toBe(SCORE_PREFIX);
    expect(scoreForClass('substring')).toBe(SCORE_SUBSTRING);
    expect(scoreForClass('none')).toBe(0);
  });

  it('scales trigram similarity below the prefix tier', () => {
    const s = scoreForClass('trigram', 0.9);
    expect(s).toBeCloseTo(0.9 * SCORE_TRIGRAM_SCALE, 4);
    expect(s).toBeLessThan(SCORE_PREFIX);
  });

  it('rejects trigram similarities below the pg_trgm threshold', () => {
    expect(scoreForClass('trigram', TRIGRAM_SIMILARITY_THRESHOLD - 0.01)).toBe(0);
    expect(scoreForClass('trigram')).toBe(0);
  });
});

describe('classRank', () => {
  it('ranks best-field-first for multi-field entities', () => {
    expect(classRank('exact')).toBeGreaterThan(classRank('prefix'));
    expect(classRank('prefix')).toBeGreaterThan(classRank('trigram'));
    expect(classRank('trigram')).toBeGreaterThan(classRank('substring'));
    expect(classRank('substring')).toBeGreaterThan(classRank('none'));
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and the escape character so they match literally', () => {
    expect(escapeLikePattern('100%_sure\\now')).toBe('100\\%\\_sure\\\\now');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern("o'brien & sons")).toBe("o'brien & sons");
  });
});
