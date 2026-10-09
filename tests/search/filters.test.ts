/**
 * Unit tests: search filter validation (contract §16.2).
 *
 * Pure validation — no database. DB-backed behavior (permission gating,
 * tenant scoping, RLS) is covered by Workstream F integration tests.
 */
import { describe, expect, it } from 'vitest';
import { SearchFiltersSchema } from '@/lib/search/filters';
import { SEARCH_ENTITY_TYPES } from '@/lib/search/types';

function parse(input: unknown) {
  return SearchFiltersSchema.parse(input);
}

describe('SearchFiltersSchema', () => {
  it('trims the query and accepts a normal search', () => {
    const f = parse({ query: '  acme corp  ' });
    expect(f.query).toBe('acme corp');
    expect(f.limit).toBe(20);
    expect(f.offset).toBe(0);
    expect(f.entityTypes).toBeUndefined();
  });

  it('rejects an empty query after trim', () => {
    expect(() => parse({ query: '   ' })).toThrow();
    expect(() => parse({ query: '' })).toThrow();
    expect(() => parse({})).toThrow();
  });

  it('rejects a query longer than 200 chars', () => {
    expect(() => parse({ query: 'x'.repeat(201) })).toThrow();
    expect(parse({ query: 'x'.repeat(200) }).query).toHaveLength(200);
  });

  it('enforces the server-side limit cap of 50 and defaults to 20', () => {
    expect(parse({ query: 'a', limit: '50' }).limit).toBe(50);
    expect(() => parse({ query: 'a', limit: '51' })).toThrow();
    expect(() => parse({ query: 'a', limit: '0' })).toThrow();
    expect(parse({ query: 'a' }).limit).toBe(20);
  });

  it('coerces and validates offset', () => {
    expect(parse({ query: 'a', offset: '10' }).offset).toBe(10);
    expect(() => parse({ query: 'a', offset: '-1' })).toThrow();
  });

  it('accepts every approved entity type and rejects unknown ones', () => {
    for (const t of SEARCH_ENTITY_TYPES) {
      expect(parse({ query: 'a', entityTypes: [t] }).entityTypes).toEqual([t]);
    }
    expect(() => parse({ query: 'a', entityTypes: ['invoice'] })).toThrow();
  });

  it('rejects the removed lead entity type (contract §16.1 REVISED)', () => {
    expect(() => parse({ query: 'a', entityTypes: ['lead'] })).toThrow();
  });

  it('accepts comma-separated and repeated type params', () => {
    expect(parse({ query: 'a', entityTypes: ['deal,task'] }).entityTypes).toEqual(['deal', 'task']);
    expect(parse({ query: 'a', entityTypes: ['deal', 'task'] }).entityTypes).toEqual([
      'deal',
      'task',
    ]);
  });

  it('treats an absent type param as no filter', () => {
    expect(parse({ query: 'a', entityTypes: [] }).entityTypes).toBeUndefined();
    expect(parse({ query: 'a' }).entityTypes).toBeUndefined();
  });

  it('validates ownerId as a UUID', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(parse({ query: 'a', ownerId: id }).ownerId).toBe(id);
    expect(() => parse({ query: 'a', ownerId: 'not-a-uuid' })).toThrow();
  });

  it('accepts an optional status string and rejects blank/oversized values', () => {
    expect(parse({ query: 'a', status: 'WON' }).status).toBe('WON');
    expect(() => parse({ query: 'a', status: '' })).toThrow();
    expect(() => parse({ query: 'a', status: 'x'.repeat(65) })).toThrow();
  });

  it('rejects unknown keys (strict object)', () => {
    expect(() => parse({ query: 'a', orgId: 'x' })).toThrow();
  });
});
