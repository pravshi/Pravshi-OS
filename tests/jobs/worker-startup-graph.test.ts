/**
 * REL-05 — the worker's start-up module graph must not include the web app's authentication
 * server (src/lib/auth/server.ts and the Better Auth package graph: ~570 modules). The worker
 * never authenticates anyone, and on a cold file cache every one of those modules is a separate
 * file read: profiled, they were the bulk of start-ups that took over 20 s.
 *
 * The REAL entry point is launched exactly as `pnpm worker` launches it (Node's TypeScript
 * transform, the worker loader, apps/worker/src/runner.ts), with a module-load recorder added. The
 * worker is given the web runtime's login (app_user) as its worker login, so it loads every
 * module, prints its first line and then refuses to start at its own role check — a natural end
 * right after the module graph is complete. LIVE DB (that role check), gated behind DB_READY.
 *
 * It cannot pass on an incomplete graph: it first asserts that the worker got past all its
 * imports (its first line, then the refusal) and that the worker modules — including the one
 * that used to drag the auth server in — were actually loaded.
 *
 * Node 22, like the worker itself (.nvmrc; CI runs 22): newer Node rejects the worker's
 * --experimental-transform-types flag, and then this suite fails on its first assertion rather
 * than passing. Where the shell's node is not 22, set WPW_NODE to a Node 22 binary, exactly as
 * for the opt-in worker end-to-end suite.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_READY } from '../workflows/helpers';

const READY = DB_READY && !!process.env.DATABASE_URL;

describe.skipIf(!READY)('worker start-up module graph (live DB, real entry point)', () => {
  let dir = '';
  let loaded: string[] = [];
  /** Everything that went through the CommonJS loader (require.cache at exit). */
  let cjsLoaded: string[] = [];
  let output = '';
  let exitCode: number | null = null;

  beforeAll(async () => {
    if (!READY) return;
    dir = mkdtempSync(join(tmpdir(), 'pravshi-worker-graph-'));
    const record = join(dir, 'loaded.txt');
    writeFileSync(
      join(dir, 'hooks.mjs'),
      `import { appendFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
  appendFileSync(${JSON.stringify(record)}, url + '\\n');
  return nextLoad(url, context);
}
`,
    );
    writeFileSync(
      join(dir, 'register.mjs'),
      `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});\n`,
    );
    writeFileSync(record, '');
    // The ESM hook sees where loading crosses into a CommonJS package, not the requires inside
    // it: this preload records the whole CommonJS side at exit, however it was reached.
    const cjsRecord = join(dir, 'cjs.json');
    writeFileSync(
      join(dir, 'cjs-record.cjs'),
      `process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(cjsRecord)}, JSON.stringify(Object.keys(require.cache))));\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      // The web runtime's login as the worker login: the worker loads everything, then refuses.
      DATABASE_URL_WORKER: process.env.DATABASE_URL,
    };
    delete env.DATABASE_URL_AUTH;
    await new Promise<void>((resolve) => {
      const child = spawn(
        process.env.WPW_NODE ?? process.execPath,
        [
          '--experimental-transform-types',
          '--require',
          join(dir, 'cjs-record.cjs'),
          '--import',
          pathToFileURL(join(dir, 'register.mjs')).href,
          '--import',
          './scripts/ci/neon-local.mjs',
          '--import',
          './scripts/worker-loader.mjs',
          'apps/worker/src/runner.ts',
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      const timer = setTimeout(() => child.kill(), 110_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });
    loaded = readFileSync(record, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((u) => decodeURIComponent(u).replace(/\\/g, '/'));
    cjsLoaded = (JSON.parse(readFileSync(cjsRecord, 'utf8')) as string[]).map((p) =>
      p.replace(/\\/g, '/'),
    );
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reached the end of start-up: every import done, then its own role-check refusal', () => {
    expect(output).toContain('[worker] liveness budgets');
    expect(output).toContain("authenticates as 'app_user', not app_worker. Refusing to start.");
    expect(exitCode).toBe(1);
  });

  it('loaded the whole worker graph, including the module that used to pull the auth server in', () => {
    for (const file of [
      'apps/worker/src/runner.ts',
      'apps/worker/src/worker.ts',
      'apps/worker/src/handlers.ts',
      'apps/worker/src/workflow-jobs.ts',
      'apps/worker/src/maintenance.ts',
      'apps/worker/src/scheduler.ts',
      // The queue core the worker imports downward, including the handler registry (ADR-010 rule 5).
      'src/lib/jobs/queue.ts',
      'src/lib/jobs/handler-registry.ts',
      'src/lib/authz/require-permission.ts',
      // The modules that used to import Sentry directly, and what they report through now.
      'src/lib/workflows/engine.ts',
      'src/lib/workflows/events.ts',
      'src/lib/workflows/triggers.ts',
      'src/lib/observability/report.ts',
    ]) {
      expect(
        loaded.some((u) => u.endsWith(file)),
        `${file} was not loaded`,
      ).toBe(true);
    }
    // The CommonJS record was written and saw CommonJS modules: an empty record proves nothing.
    expect(cjsLoaded.length).toBeGreaterThan(0);
  });

  it('never loads the authentication server or the Better Auth package graph', () => {
    const forbidden = loaded.filter((u) =>
      /src\/lib\/auth\/(server|session)\.ts$|\/node_modules\/(\.pnpm\/)?(better-auth|@better-auth|better-call|kysely)/.test(
        u,
      ),
    );
    expect(forbidden, `the worker loaded:\n${forbidden.slice(0, 10).join('\n')}`).toEqual([]);
  });

  it('never loads Sentry or OpenTelemetry — on either the ESM or the CommonJS side', () => {
    const sentry = /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?@(sentry|opentelemetry)\//;
    const viaEsm = loaded.filter((u) => sentry.test(u));
    const viaCjs = cjsLoaded.filter((p) => sentry.test(p));
    expect(viaEsm, `ESM loads:\n${viaEsm.slice(0, 5).join('\n')}`).toEqual([]);
    expect(
      viaCjs,
      `${viaCjs.length} CommonJS modules, e.g.:\n${viaCjs.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });
});
