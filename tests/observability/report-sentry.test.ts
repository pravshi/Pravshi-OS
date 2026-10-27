/**
 * REL-05 — the reporting facade against the REAL Sentry SDK (@sentry/nextjs, server build),
 * initialised in-process with an in-memory transport: no DSN is contacted, nothing leaves the
 * process. Each forwarded event is compared with the event the same direct Sentry call produces.
 *
 * Proven (as far as an in-process SDK allows — not a real Sentry project, not the Next.js
 * request pipeline):
 *   - the facade's events carry the same message, level, tags, extra and exception as direct
 *     calls, and are delivered through the transport;
 *   - the caller's request (isolation) scope applies, also when the call follows an await;
 *   - two concurrent requests keep their own scopes (no leakage across the async forwarding);
 *   - a breadcrumb added through the facade precedes, and is attached to, the next capture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { markWorkerProcess } from '@/lib/jobs/process-context';
import * as report from '@/lib/observability/report';

type Event = {
  message?: string;
  level?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  breadcrumbs?: Array<{ message?: string; category?: string }>;
};
const delivered: Event[] = [];

beforeAll(() => {
  markWorkerProcess(false);
  report.resetReporterForTests();
  Sentry.init({
    dsn: 'https://public@o0.ingest.example.test/1',
    defaultIntegrations: false,
    integrations: [],
    tracesSampleRate: 0,
    transport: () => ({
      send: async (envelope: unknown) => {
        const [, items] = envelope as [unknown, Array<[{ type: string }, Event]>];
        for (const [header, body] of items) if (header.type === 'event') delivered.push(body);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
});

afterAll(async () => {
  await Sentry.close(2_000);
});

/** Lets the facade's forwarding run, then flushes the client. */
const drain = async () => {
  await new Promise((r) => setTimeout(r, 30));
  await Sentry.flush(2_000);
};
const byMessage = (m: string) => delivered.find((e) => e.message === m);
const comparable = (e: Event | undefined) => ({
  level: e?.level,
  tags: e?.tags,
  extra: e?.extra,
});

describe('observability/report against the real Sentry SDK', () => {
  it('a forwarded message matches the direct call: level, tags, extra, request scope; delivered', async () => {
    await Sentry.withIsolationScope(async () => {
      Sentry.getIsolationScope().setTag('request', 'R1');
      const context = { level: 'warning' as const, tags: { source: 'x' }, extra: { n: 1 } };
      Sentry.captureMessage('direct-1', context);
      report.captureMessage('facade-1', context);
    });
    await drain();
    expect(byMessage('facade-1')).toBeDefined();
    expect(comparable(byMessage('facade-1'))).toEqual(comparable(byMessage('direct-1')));
    expect(byMessage('facade-1')?.tags).toMatchObject({ request: 'R1', source: 'x' });
  });

  it('a forwarded exception matches the direct call', async () => {
    await Sentry.withIsolationScope(async () => {
      Sentry.getIsolationScope().setTag('request', 'R2');
      const context = { tags: { source: 'workflow-engine' }, extra: { executionId: 'e1' } };
      Sentry.captureException(new TypeError('direct-2'), context);
      report.captureException(new TypeError('facade-2'), context);
    });
    await drain();
    const direct = delivered.find((e) => e.exception?.values?.[0]?.value === 'direct-2');
    const facade = delivered.find((e) => e.exception?.values?.[0]?.value === 'facade-2');
    expect(facade?.exception?.values?.[0]?.type).toBe('TypeError');
    expect(comparable(facade)).toEqual(comparable(direct));
    expect(facade?.tags).toMatchObject({ request: 'R2', source: 'workflow-engine' });
  });

  it('keeps the request scope across an await, and two concurrent requests apart', async () => {
    const request = (id: string, wait: number) =>
      Sentry.withIsolationScope(async () => {
        Sentry.getIsolationScope().setTag('request', id);
        await new Promise((r) => setTimeout(r, wait));
        report.captureMessage(`after-await-${id}`, { level: 'info' });
      });
    await Promise.all([request('A', 15), request('B', 5)]);
    await drain();
    expect(byMessage('after-await-A')?.tags).toMatchObject({ request: 'A' });
    expect(byMessage('after-await-B')?.tags).toMatchObject({ request: 'B' });
  });

  it('a breadcrumb added through the facade is attached to the following capture', async () => {
    await Sentry.withIsolationScope(async () => {
      report.addBreadcrumb({
        category: 'workflows',
        level: 'warning',
        message: 'dispatch depth guard tripped — event dropped',
      });
      report.captureMessage('after-breadcrumb', { level: 'error' });
    });
    await drain();
    const crumbs = byMessage('after-breadcrumb')?.breadcrumbs ?? [];
    expect(crumbs.map((c) => c.message)).toContain('dispatch depth guard tripped — event dropped');
  });
});
