/**
 * REL-05 — src/lib/observability/report.ts with a mocked Sentry module whose factory records
 * whether it was ever imported. Proven:
 *   - worker mode: every call is a no-op and Sentry is never imported;
 *   - web mode: each call reaches Sentry with exactly its arguments, in the order made;
 *   - an import that fails, or a capture that throws, never reaches the caller (logged once).
 * Real-SDK equivalence (event content, scope, delivery) is in report-sentry.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  imported: 0,
  calls: [] as Array<[string, unknown[]]>,
  failImport: false,
  throwOnCapture: false,
}));

vi.mock('@sentry/nextjs', () => {
  hoisted.imported += 1;
  if (hoisted.failImport) throw new Error('sentry failed to load');
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      hoisted.calls.push([name, args]);
      if (hoisted.throwOnCapture) throw new Error('capture blew up');
    };
  return {
    captureMessage: record('captureMessage'),
    captureException: record('captureException'),
    addBreadcrumb: record('addBreadcrumb'),
  };
});

import { markWorkerProcess } from '@/lib/observability/process-context';
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  resetReporterForTests,
} from '@/lib/observability/report';

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  hoisted.imported = 0;
  hoisted.calls.length = 0;
  hoisted.failImport = false;
  hoisted.throwOnCapture = false;
  resetReporterForTests();
});
afterEach(() => {
  markWorkerProcess(false);
  vi.restoreAllMocks();
});

describe('observability/report — worker mode', () => {
  it('is a no-op and never imports Sentry', async () => {
    markWorkerProcess(true);
    captureMessage('m', { level: 'warning' });
    captureException(new Error('e'), { tags: { source: 'x' } });
    addBreadcrumb({ category: 'c', message: 'b' });
    await settle();
    expect(hoisted.imported).toBe(0);
    expect(hoisted.calls).toEqual([]);
  });
});

describe('observability/report — web mode', () => {
  it('forwards each call with exactly its arguments, in the order made', async () => {
    const error = new Error('boom');
    const crumb = {
      category: 'workflows',
      level: 'warning' as const,
      message: 'dispatch depth guard tripped — event dropped',
      data: { type: 'deal.created', depth: 5 },
    };
    addBreadcrumb(crumb);
    captureMessage('workflow event dispatch failed', {
      level: 'error',
      tags: { source: 'workflow-dispatch' },
      extra: { a: 1 },
    });
    captureException(error, { tags: { source: 'workflow-engine' }, extra: { b: 2 } });
    await settle();
    expect(hoisted.calls).toEqual([
      ['addBreadcrumb', [crumb]],
      [
        'captureMessage',
        [
          'workflow event dispatch failed',
          { level: 'error', tags: { source: 'workflow-dispatch' }, extra: { a: 1 } },
        ],
      ],
      ['captureException', [error, { tags: { source: 'workflow-engine' }, extra: { b: 2 } }]],
    ]);
    expect(hoisted.calls[2]![1][0]).toBe(error); // the same object, not a copy
  });

  it('a capture that throws never reaches the caller, and later calls still go through', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.throwOnCapture = true;
    expect(() => captureMessage('first')).not.toThrow();
    await settle();
    hoisted.throwOnCapture = false;
    captureMessage('second');
    await settle();
    expect(hoisted.calls.map(([, a]) => a[0])).toEqual(['first', 'second']);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe('observability/report — Sentry cannot be loaded', () => {
  it('never throws into the caller and logs once', async () => {
    vi.resetModules();
    vi.doMock('@sentry/nextjs', () => {
      throw new Error('sentry failed to load');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fresh = await import('@/lib/observability/report');
    fresh.resetReporterForTests();
    expect(() => {
      fresh.captureMessage('a');
      fresh.captureException(new Error('b'));
      fresh.addBreadcrumb({ message: 'c' });
    }).not.toThrow();
    await settle();
    expect(hoisted.calls).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('error reporting unavailable');
  });
});
