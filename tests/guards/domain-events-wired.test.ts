import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Redesign Step 6 — the domain-event ports must be wired in every process that emits.
 *
 * crm, work and the inbound-webhook receiver emit through src/lib/events, which forwards to the one
 * subscriber registered per port. Registration is a side effect of importing the composition root,
 * src/lib/composition/domain-events.ts. A process that emits without having loaded it silently
 * stops triggering workflows and outbound webhooks (the port reports each undelivered event, but
 * the automation is still lost), so this pins, statically:
 *
 *   - the web app loads it: instrumentation.ts, in the nodejs runtime branch only (Next calls
 *     register() once per server instance, before any request; the edge runtime cannot run the
 *     database-backed subscribers and emits nothing);
 *   - the worker loads it: apps/worker/src/runner.ts, with the modules that register job handlers;
 *   - nothing else in src loads it or registers a subscriber, so there is one wiring, in one place.
 *
 * The files are found by walking the file system, not with `git grep`, so a file that is not yet
 * tracked is checked too. Static source checks like the other guards: a heuristic that fails
 * closed on a shape it does not recognise.
 */

const ROOT = process.cwd();
const COMPOSITION = 'src/lib/composition/domain-events.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(rel);
  }
  return out;
}

const SOURCE_ROOTS = ['src', 'apps/web/src', 'apps/worker/src'] as const;
const SRC = SOURCE_ROOTS.flatMap((dir) => walk(dir));

/** Code only: comments dropped, so a path named in prose never counts as an import. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

describe('domain events are wired in every emitting process', () => {
  it('the composition root exists and registers both ports', () => {
    expect(existsSync(join(ROOT, COMPOSITION))).toBe(true);
    const source = code(read(COMPOSITION));
    expect(source).toMatch(/registerWorkflowEventSubscriber\(\s*dispatchWorkflowEvent\s*\)/);
    expect(source).toMatch(/registerIntegrationEventSubscriber\(/);
    expect(source).toMatch(/emitIntegrationEvent\(auth, eventKey, data, options\)/);
  });

  it('the web app loads it from apps/web/src/instrumentation.ts, in the nodejs runtime branch only', () => {
    // With a src/ folder Next 15 loads apps/web/src/instrumentation.ts and IGNORES a root instrumentation.ts
    // (a real build emits no .next/server/instrumentation.js for the root file), so the wiring must
    // live here — a first version of Step 6 put it in the root file and registered nothing.
    expect(existsSync(join(ROOT, 'apps/web/src/instrumentation.ts'))).toBe(true);
    const source = code(read('apps/web/src/instrumentation.ts'));
    const nodejs = /if \(process\.env\.NEXT_RUNTIME === 'nodejs'\) \{([\s\S]*?)\n {2}\}/.exec(
      source,
    );
    expect(nodejs, 'apps/web/src/instrumentation.ts has no nodejs runtime branch').not.toBeNull();
    expect(nodejs![1]).toContain("await import('@/lib/composition/domain-events');");
    expect(source).not.toMatch(/NEXT_RUNTIME === 'edge'/);
    expect(source).toMatch(/export async function register\(/);
    // Registration only: nothing in instrumentation may touch the database (its own contract).
    expect(source).not.toMatch(/withAuthorizedDb|@\/lib\/db|connectWithWake/);
  });

  it('apps/web/instrumentation.ts (beside src/) is not relied on: Next ignores it when src/ exists', () => {
    expect(existsSync(join(ROOT, 'apps/web/src/app'))).toBe(true);
    expect(code(read('apps/web/instrumentation.ts'))).not.toContain('composition');
  });

  it('the worker loads it from apps/worker/src/runner.ts', () => {
    expect(code(read('apps/worker/src/runner.ts'))).toContain(
      "await import('@/lib/composition/domain-events');",
    );
  });

  it('nothing else in src loads the composition root, and only it registers subscribers', () => {
    const importsComposition = /composition\/domain-events['"]/;
    const registers = /register(Workflow|Integration)EventSubscriber\(/;
    const importers: string[] = [];
    const registrars: string[] = [];
    for (const file of SRC) {
      if (file === COMPOSITION) continue;
      const source = code(read(file));
      if (importsComposition.test(source)) importers.push(file);
      // events/index.ts defines the register functions; every other file may only use them via
      // the composition root.
      if (file !== 'src/lib/events/index.ts' && registers.test(source)) registrars.push(file);
    }
    expect(importers, 'only the entry points may load the composition root').toEqual([
      'apps/web/src/instrumentation.ts',
      'apps/worker/src/runner.ts',
    ]);
    expect(registrars, 'only the composition root may register a subscriber').toEqual([]);
  });

  it('every module that emits does so through the port, not by importing its subscribers', () => {
    // The five emitting files import the port; the boundary guard (module-boundaries) is what
    // forbids crm, work and integrations from importing workflows or the fan-out directly.
    for (const file of [
      'src/lib/crm/deals.ts',
      'src/lib/crm/pipelines.ts',
      'src/lib/work/projects.ts',
      'src/lib/work/tasks.ts',
      'src/lib/integrations/inbound.ts',
    ]) {
      const source = code(read(file));
      expect(source, `${file} must emit through @/lib/events`).toMatch(/from '@\/lib\/events'/);
      expect(source, `${file} must not import the workflow dispatcher`).not.toMatch(
        /from '(@\/lib\/workflows|\.\.\/workflows|\.\/workflows)\/events'/,
      );
    }
  });
});
