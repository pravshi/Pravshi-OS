import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production migration runbook pins the exact journal state an operator must reach:
 * the final idx and tag, the pending chain's `when` values and file-byte hashes, and the
 * final count and max_created_at. When a migration lands without the runbook following,
 * the operator's own verification steps contradict the repository on the day of the run
 * (the runbook stopped at 0062 while main moved to 0064). This guard makes that drift a
 * CI failure in the pull request that adds the migration.
 *
 * Static — no database needed.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);

type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(readFileSync(root('drizzle', 'meta', '_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};
const entries = journal.entries;
const last = entries.at(-1)!;
const RUNBOOK = readFileSync(root('docs', 'runbooks', 'production-migration.md'), 'utf8');

/** sha256 of the file's bytes, exactly as scripts/migrate-ws.mjs records it. */
const fileHash = (tag: string) =>
  createHash('sha256')
    .update(readFileSync(root('drizzle', `${tag}.sql`), 'utf8'))
    .digest('hex');

/** Production's recorded boundary (0044_workflow_engine); the pending chain starts after it. */
const PRODUCTION_BOUNDARY_IDX = 44;

describe('production migration runbook matches the migration journal', () => {
  it('names the journal tail in the checkout check', () => {
    expect(RUNBOOK).toContain(
      `# expected at the current release: ${entries.length} ${last.idx} ${last.tag}`,
    );
  });

  it('lists every pending migration in Appendix A with its when and file-byte hash', () => {
    for (const e of entries.filter((x) => x.idx > PRODUCTION_BOUNDARY_IDX)) {
      const row = new RegExp(
        `\\|\\s*${e.idx}\\s*\\|\\s*\`${e.tag}\`\\s*\\|\\s*${e.when}\\s*\\|\\s*\`${fileHash(e.tag)}\`\\s*\\|`,
      );
      expect(RUNBOOK, `Appendix A row for idx ${e.idx} ${e.tag}`).toMatch(row);
    }
  });

  it('states the final count and max_created_at the run must reach', () => {
    expect(RUNBOOK).toContain(
      `Final expected state after a complete run: count \`${entries.length}\`,\nmax_created_at \`${last.when}\`.`,
    );
    expect(RUNBOOK).toContain(
      `journal == repo (count ${entries.length} / max ${last.when} / hashes)`,
    );
  });

  it('states the pending range up to the journal tail', () => {
    expect(RUNBOOK).toContain(`## Appendix A — The pending chain (idx 45–${last.idx})`);
    expect(RUNBOOK).toContain(
      `done: applied ${last.idx - PRODUCTION_BOUNDARY_IDX}, total ${entries.length}`,
    );
  });
});
