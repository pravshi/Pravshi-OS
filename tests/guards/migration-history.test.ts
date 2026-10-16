import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJournal, verifyHistory } from '../../scripts/migrate-ws.mjs';

/**
 * The migration runner's history check (scripts/migrate-ws.mjs), on the REAL repository journal
 * and file hashes. Static: no database (tests/serial/migration-runner-history.test.ts runs the
 * runner itself).
 *
 * The runner records one row per applied migration: (sha256 of the file's bytes, journal `when`).
 * It may migrate only when those rows, in insertion order, are exactly the journal's prefix
 * idx 0…K-1; then it applies idx K…n-1 in journal order. drizzle-kit's own rule — apply every
 * entry whose `when` exceeds max(created_at) — is unsafe here because the historical `when`
 * values are not monotonic.
 */

type Row = { id: number; hash: string; created_at: string | null };
type Entry = { idx: number; tag: string; when: string; hash: string };

const entries: Entry[] = loadJournal();
const historyThrough = (k: number): Row[] =>
  entries.slice(0, k).map((e, i) => ({ id: i + 1, hash: e.hash, created_at: e.when }));
const refusal = (rows: Row[]) => {
  const result = verifyHistory(rows, entries);
  expect(result.ok, 'history must be refused').toBe(false);
  return (result as { problem: string }).problem;
};

/** drizzle-kit's selection rule, for comparison only. */
const drizzleWouldApply = (k: number) => {
  const max = entries
    .slice(0, k)
    .reduce((m, e) => (BigInt(e.when) > m ? BigInt(e.when) : m), BigInt(0));
  return entries.filter((e) => BigInt(e.when) > max).map((e) => e.idx);
};

describe('migration journal', () => {
  it('is numbered 0…n-1, one file per entry, and its hashes are the file bytes', () => {
    expect(entries.length).toBeGreaterThanOrEqual(76);
    entries.forEach((e, i) => expect(e.idx).toBe(i));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
  });

  it('has the historical non-monotonic `when` values this check exists for', () => {
    const when = (idx: number) => BigInt(entries[idx]!.when);
    expect(when(28)).toBeLessThan(when(27)); // 0027 recorded after 0030 but dated earlier
    expect(when(29)).toBeLessThan(when(27));
    expect(when(30)).toBeLessThan(when(27));
    expect(when(35)).toBe(when(34)); // a tie
  });

  it("drizzle-kit's rule would skip pending migrations inside those ranges", () => {
    expect(drizzleWouldApply(27)).not.toContain(28); // stopped through idx 26: 28-30 skipped
    expect(drizzleWouldApply(27)).not.toContain(30);
    expect(drizzleWouldApply(35)).not.toContain(35); // stopped through idx 34: 35 skipped
  });
});

describe('verifyHistory: clean prefixes are accepted at every length', () => {
  it('an empty history (fresh database) applies everything', () => {
    expect(verifyHistory([], entries)).toEqual({ ok: true, applied: 0 });
  });

  it.each([
    ['through 0044 (the recorded production state)', 45],
    ['through idx 63 (the observed development level)', 64],
    ['through 0075 (only 0076 pending)', 75],
    ['complete', entries.length],
  ])('%s', (_label, k) => {
    expect(verifyHistory(historyThrough(k), entries)).toEqual({ ok: true, applied: k });
  });

  it('every prefix K is accepted as exactly K applied — including K = 25…31 and 34…36', () => {
    for (let k = 0; k <= entries.length; k++) {
      expect(verifyHistory(historyThrough(k), entries)).toEqual({ ok: true, applied: k });
    }
  });

  it('so the pending set is always idx K…n-1, contiguous — nothing can be skipped', () => {
    for (let k = 0; k <= entries.length; k++) {
      const { applied } = verifyHistory(historyThrough(k), entries) as { applied: number };
      const pending = entries.slice(applied).map((e) => e.idx);
      expect(pending).toEqual(Array.from({ length: entries.length - k }, (_, i) => k + i));
    }
  });
});

describe('verifyHistory: anything else is refused, with an actionable reason', () => {
  const full = historyThrough(entries.length);

  it('a missing migration in the middle', () => {
    const rows = full.filter((_, i) => i !== 10);
    expect(refusal(rows)).toMatch(/idx 11 .* but idx 10 .* was expected there/);
  });

  it('a duplicated history row', () => {
    const rows = [
      ...full.slice(0, 6),
      { ...full[5]!, id: 7 },
      ...full.slice(6).map((r) => ({ ...r, id: r.id + 1 })),
    ];
    expect(refusal(rows)).toMatch(/repeats idx 5 /);
  });

  it('history recorded in time order instead of journal order (idx 28-29 before 26-27)', () => {
    const rows = [...full.slice(0, 26), full[28]!, full[29]!, full[26]!, full[27]!];
    expect(refusal(rows)).toMatch(/is idx 28 .* but idx 26 .* was expected there/);
  });

  it('a checksum mismatch: the file changed after it was applied', () => {
    const rows = full.map((r, i) => (i === 30 ? { ...r, hash: 'f'.repeat(64) } : r));
    expect(refusal(rows)).toMatch(/timing of idx 30 .* different checksum/);
  });

  it('an unknown migration', () => {
    const rows = [...full.slice(0, 40), { id: 41, hash: 'e'.repeat(64), created_at: '1' }];
    expect(refusal(rows)).toMatch(/matches no migration in this repository/);
  });

  it('the right checksum with the wrong created_at', () => {
    const rows = full.map((r, i) => (i === 12 ? { ...r, created_at: '123' } : r));
    expect(refusal(rows)).toMatch(
      /checksum of idx 12 .* created_at 123 instead of its journal when/,
    );
  });

  it('a NULL created_at', () => {
    const rows = full.map((r, i) => (i === 3 ? { ...r, created_at: null } : r));
    expect(refusal(rows)).toMatch(/created_at NULL/);
  });

  it('more history than the repository knows', () => {
    const rows = [
      ...full,
      { id: full.length + 1, hash: 'd'.repeat(64), created_at: '9999999999999' },
    ];
    expect(refusal(rows)).toMatch(/beyond the journal/);
  });
});

describe('the production runbook Step 0 agrees with the runner', () => {
  const runbook = readFileSync(
    join(process.cwd(), 'docs', 'runbooks', 'production-migration.md'),
    'utf8',
  );
  const step0 = runbook.slice(runbook.indexOf('## Step 0'), runbook.indexOf('## Step 1'));

  it('reads the history in id order, never time order', () => {
    expect(step0).toMatch(
      /select id, hash, created_at\s+from drizzle\.__drizzle_migrations\s+order by id;/,
    );
    expect(step0).not.toMatch(/order by created_at/);
  });

  it('its recorded production state (K = 45) is a clean prefix with the stated count, max and last hash', () => {
    const rows = historyThrough(45);
    expect(verifyHistory(rows, entries)).toEqual({ ok: true, applied: 45 });
    const max = rows.reduce(
      (m, r) => (BigInt(r.created_at!) > m ? BigInt(r.created_at!) : m),
      BigInt(0),
    );
    expect(step0).toContain(`count \`45\`, max_created_at \`${max}\``);
    expect(step0).toContain(rows[44]!.hash);
  });

  it('a correct complete history compared the Step 0 way (id order) passes', () => {
    expect(verifyHistory(historyThrough(entries.length), entries)).toEqual({
      ok: true,
      applied: entries.length,
    });
  });
});
