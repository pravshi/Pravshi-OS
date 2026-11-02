import { AsyncLocalStorage } from 'node:async_hooks';
import Module, { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as React from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * heldNavPermissions(): unchanged answers, failures that still propagate, and React cache()
 * deduplication inside a React Server Components render.
 *
 * A RENDERER-MODEL test, not a Next.js integration test. In the app, Next's server-component
 * layer aliases `react` to next/dist/server/route-modules/app-page/vendored/rsc/react
 * (next/dist/build/create-compiler-aliases.js), which re-exports the react-server build bundled
 * into the app-page runtime. This suite loads the unbundled copy of that same vendored build
 * (next/dist/compiled/react/react.react-server.js, same React version) as nav.ts's `react`, and
 * Next's vendored RSC renderer (react-server-dom-webpack/server.node) with its `react` /
 * `react-dom` requires aliased to the same files, so both share one React instance and the
 * renderer's request scope is the one cache() reads. What it does not exercise: Next's request
 * pipeline, bundling, layouts, and real sessions — those need a running app. No database: the
 * session and the transaction are mocked, and their call counts are the evidence.
 */

vi.mock('react', async () => {
  const { createRequire: req } = await import('node:module');
  return req(import.meta.url)('next/dist/compiled/react/react.react-server.js');
});

const { requireAuthenticated, withAuthorizedDb, txExecute } = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  withAuthorizedDb: vi.fn(),
  txExecute: vi.fn(),
}));
vi.mock('@/lib/authz/page', () => ({ requireAuthenticated }));
vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb }));

import { heldNavPermissions } from '@/lib/authz/nav';

const nodeRequire = createRequire(import.meta.url);

// Node-level aliases for the renderer only, restored after the suite so no other file sees them.
// The vendored modules ask for both `react` and `next/dist/compiled/react`; the server layer
// sends each to the react-server build.
const reactServer = nodeRequire.resolve('next/dist/compiled/react/react.react-server.js');
const aliases: Record<string, string> = {
  react: reactServer,
  'next/dist/compiled/react': reactServer,
  'react-dom': nodeRequire.resolve('next/dist/compiled/react-dom/react-dom.react-server.js'),
};
type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolve = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return originalResolve.call(this, aliases[request] ?? request, ...rest);
};
afterAll(() => {
  moduleInternals._resolveFilename = originalResolve;
});

type PipeableStream = { pipe(destination: NodeJS.WritableStream): void };
const { renderToPipeableStream } = nodeRequire(
  'next/dist/compiled/react-server-dom-webpack/server.node',
) as {
  renderToPipeableStream(
    model: unknown,
    webpackMap: Record<string, never>,
    options: { onError(error: unknown): void },
  ): PipeableStream;
};
const { getRedirectError } = nodeRequire('next/dist/client/components/redirect') as {
  getRedirectError(url: string, type: string): Error;
};

const CTX = { personId: 'p-1', orgId: 'o-1', aal: 'aal1' as const };

const NAV_PERMISSIONS = [
  'users.view',
  'users.manage',
  'roles.view',
  'roles.manage',
  'teams.view',
  'departments.view',
  'audit_logs.view',
  'companies.view',
  'contacts.view',
  'deals.view',
  'activities.view',
  'pipelines.view',
  'projects.view',
  'tasks.view',
  'workflows.view',
  'jobs.view',
  'reports.view',
  'notifications.view',
];

function rowsHolding(held: string[]) {
  return { rows: NAV_PERMISSIONS.map((key) => ({ key, held: held.includes(key) })) };
}

/** One RSC render = one request. Resolves with the flight payload and every reported error. */
function render(model: unknown): Promise<{ payload: string; errors: unknown[] }> {
  return new Promise((resolve, reject) => {
    const errors: unknown[] = [];
    const out = new PassThrough();
    let payload = '';
    out.on('data', (chunk: Buffer) => (payload += chunk.toString()));
    out.on('end', () => resolve({ payload, errors }));
    out.on('error', reject);
    renderToPipeableStream(
      model,
      {},
      {
        onError: (e) => {
          errors.push(e);
        },
      },
    ).pipe(out);
  });
}

/** A server component asking the question, as the sidebar / tab bar / home page do. */
async function NavProbe({ name }: { name: string }) {
  const held = await heldNavPermissions();
  return React.createElement('span', { id: name }, [...held].sort().join(','));
}

function Shell() {
  return React.createElement(
    'div',
    null,
    React.createElement(NavProbe, { name: 'sidebar' }),
    React.createElement(NavProbe, { name: 'tab-bar' }),
    React.createElement(NavProbe, { name: 'drawer' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticated.mockResolvedValue(CTX);
  txExecute.mockResolvedValue(rowsHolding(['users.view', 'teams.view']));
  withAuthorizedDb.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: txExecute }),
  );
});

describe('heldNavPermissions — results unchanged', () => {
  it('asks authz.has() for every nav permission under the viewer identity', async () => {
    await heldNavPermissions();
    expect(withAuthorizedDb).toHaveBeenCalledWith(CTX, expect.any(Function));
    const query = new PgDialect().sqlToQuery(txExecute.mock.calls[0]![0] as SQL);
    expect(query.sql).toContain('authz.has(v.key)');
    expect(query.params).toEqual(NAV_PERMISSIONS);
  });

  it('returns exactly the permissions reported as held', async () => {
    const held = await heldNavPermissions();
    expect([...held].sort()).toEqual(['teams.view', 'users.view']);
  });

  it('fails closed: nothing held, or no rows, is an empty set', async () => {
    txExecute.mockResolvedValueOnce(rowsHolding([]));
    expect((await heldNavPermissions()).size).toBe(0);
    txExecute.mockResolvedValueOnce({ rows: [] });
    expect((await heldNavPermissions()).size).toBe(0);
  });

  it('is typed read-only, because callers in one render share the instance', async () => {
    const held = await heldNavPermissions();
    // Never called: pnpm typecheck fails if the return type stops being read-only.
    const mutate = () => {
      // @ts-expect-error — ReadonlySet has no add()
      held.add('roles.manage');
    };
    expect(typeof mutate).toBe('function');
  });
});

describe('heldNavPermissions — failures propagate', () => {
  it('the /login redirect reaches the caller and no transaction is opened', async () => {
    const redirect = getRedirectError('/login', 'replace');
    requireAuthenticated.mockRejectedValueOnce(redirect);
    await expect(heldNavPermissions()).rejects.toBe(redirect);
    expect(withAuthorizedDb).not.toHaveBeenCalled();
  });

  it('a database error reaches the caller unchanged', async () => {
    const dbError = Object.assign(new Error('connection lost'), { code: '08006' });
    withAuthorizedDb.mockRejectedValueOnce(dbError);
    await expect(heldNavPermissions()).rejects.toBe(dbError);
  });
});

describe('heldNavPermissions — React cache() inside a server components render', () => {
  it('three server components in one render share one lookup and one transaction', async () => {
    const { payload, errors } = await render(React.createElement(Shell));
    expect(errors).toEqual([]);
    expect(requireAuthenticated).toHaveBeenCalledTimes(1);
    expect(withAuthorizedDb).toHaveBeenCalledTimes(1);
    expect(payload.match(/teams\.view,users\.view/g)?.length).toBe(3);
  });

  it('never carries an answer into another request or another viewer', async () => {
    txExecute
      .mockResolvedValueOnce(rowsHolding(['users.view']))
      .mockResolvedValueOnce(rowsHolding(['reports.view']));
    const first = await render(React.createElement(Shell));
    const second = await render(React.createElement(Shell));
    expect(withAuthorizedDb).toHaveBeenCalledTimes(2);
    expect(first.payload).toContain('users.view');
    expect(first.payload).not.toContain('reports.view');
    expect(second.payload).toContain('reports.view');
    expect(second.payload).not.toContain('users.view');
  });

  it('is a pass-through outside a render: every direct call asks again', async () => {
    await heldNavPermissions();
    await heldNavPermissions();
    expect(withAuthorizedDb).toHaveBeenCalledTimes(2);
  });

  it('a redirect inside a render reaches every caller and is resolved once', async () => {
    const redirect = getRedirectError('/login', 'replace');
    requireAuthenticated.mockRejectedValue(redirect);
    const { errors } = await render(React.createElement(Shell));
    expect(requireAuthenticated).toHaveBeenCalledTimes(1);
    expect(withAuthorizedDb).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e === redirect)).toBe(true);
  });

  it('concurrent renders for different viewers each see only their own answer', async () => {
    // Each render is one viewer's request. The viewer travels in AsyncLocalStorage — as the
    // request's headers do in Next — and each viewer holds exactly one, distinct permission.
    const viewer = new AsyncLocalStorage<number>();
    requireAuthenticated.mockImplementation(async () => {
      const i = viewer.getStore();
      if (i === undefined) throw new Error('no viewer in scope');
      return { ...CTX, personId: `p-${i}` };
    });
    withAuthorizedDb.mockImplementation(
      async (ctx: { personId: string }, fn: (tx: unknown) => unknown) => {
        const i = Number(ctx.personId.slice(2));
        await delay((i * 7) % 5); // finish out of order
        return fn({ execute: async () => rowsHolding([NAV_PERMISSIONS[i]!]) });
      },
    );

    // Awaits before asking — the home page's shape, which takes the AsyncLocalStorage path of
    // the renderer's request scope rather than the synchronous one.
    async function AwaitingProbe({ wait }: { wait: number }) {
      await delay(wait);
      const held = await heldNavPermissions();
      return React.createElement('span', null, `held<${[...held].join(',')}>`);
    }
    function ViewerShell({ i }: { i: number }) {
      return React.createElement(
        'div',
        null,
        React.createElement(NavProbe, { name: 'sidebar' }),
        React.createElement(AwaitingProbe, { wait: (i * 3) % 4 }),
        React.createElement(AwaitingProbe, { wait: (i * 5) % 3 }),
      );
    }

    const viewers = [0, 1, 2, 3, 4, 5];
    const renders = await Promise.all(
      viewers.map((i) => viewer.run(i, () => render(React.createElement(ViewerShell, { i })))),
    );

    // One session lookup and one transaction per request — not per component, not shared.
    expect(requireAuthenticated).toHaveBeenCalledTimes(viewers.length);
    expect(withAuthorizedDb).toHaveBeenCalledTimes(viewers.length);
    const asked = withAuthorizedDb.mock.calls.map(
      ([ctx]) => (ctx as { personId: string }).personId,
    );
    expect([...asked].sort()).toEqual(viewers.map((i) => `p-${i}`).sort());

    renders.forEach(({ payload, errors }, i) => {
      expect(errors).toEqual([]);
      const own = NAV_PERMISSIONS[i]!;
      // The two awaiting probes: exactly this viewer's permission.
      expect([...payload.matchAll(/held<([^>]*)>/g)].map((m) => m[1])).toEqual([own, own]);
      // The synchronous probe, and nothing from any other viewer anywhere in the payload.
      for (const [j, key] of NAV_PERMISSIONS.slice(0, viewers.length).entries()) {
        if (j === i) expect(payload).toContain(key);
        else expect(payload).not.toContain(key);
      }
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
