/**
 * SSRF guard — redirects, per-hop re-validation and per-hop pinning, driven
 * through handleWebhook. DNS is mocked and node:http / node:https are replaced
 * by a scripted fake, so no connection is ever opened. The fake records each
 * request and asks its `lookup` option for an address exactly as Node's
 * connect does, which is the address the real connection would use.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/jobs/handler-registry', () => ({
  registerHandler: vi.fn(),
}));

type LookupFn = (
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address: unknown, family?: number) => void,
) => void;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  connectAll: unknown;
  connectSingle: unknown;
}

const { dnsLookup, net } = vi.hoisted(() => {
  const state = {
    requests: [] as Recorded[],
    responses: [] as Array<{ status: number; location?: string }>,
  };
  return { dnsLookup: vi.fn(), net: state };
});

vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

function fakeRequest(
  url: URL,
  options: { method: string; headers: Record<string, string>; lookup: LookupFn },
  onResponse: (res: EventEmitter & { statusCode: number; headers: object }) => void,
) {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const chunks: Buffer[] = [];
  req.setTimeout = () => req;
  req.destroy = (err?: Error) => req.emit('error', err ?? new Error('destroyed'));
  req.write = (c: Buffer) => chunks.push(c);
  req.end = () => {
    const record: Recorded = {
      url: url.toString(),
      method: options.method,
      headers: { ...options.headers },
      body: Buffer.concat(chunks).toString(),
      connectAll: undefined,
      connectSingle: undefined,
    };
    options.lookup(url.hostname, { all: true }, (_e, address) => (record.connectAll = address));
    options.lookup(url.hostname, {}, (_e, address) => (record.connectSingle = address));
    net.requests.push(record);
    const next = net.responses.shift() ?? { status: 200 };
    const res = Object.assign(new EventEmitter(), {
      statusCode: next.status,
      headers: next.location ? { location: next.location } : {},
    });
    queueMicrotask(() => {
      onResponse(res);
      res.emit('end');
    });
  };
  return req;
}

vi.mock('node:http', () => ({ request: fakeRequest, default: { request: fakeRequest } }));
vi.mock('node:https', () => ({ request: fakeRequest, default: { request: fakeRequest } }));

import { handleWebhook } from '../../src/worker/handlers';
import type { JobExecutionContext } from '../../src/lib/jobs/handler-registry';

const answers = (...ips: string[]) =>
  ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** DNS by hostname; an unknown name has no answer. */
function dnsTable(table: Record<string, string[]>) {
  dnsLookup.mockImplementation(async (host: string) => answers(...(table[host] ?? [])));
}

function run(payload: Record<string, unknown>) {
  const ctx = {
    job: { id: '00000000-0000-4000-8000-000000000001', orgId: 'org', payload },
    auth: {},
    signal: new AbortController().signal,
    workerId: 'worker-test',
  } as unknown as JobExecutionContext;
  return handleWebhook(ctx);
}

const SIGNED = {
  url: 'https://hooks.example.com/start',
  method: 'POST',
  body: { event: 'deal.moved' },
  signatureSecret: 'test-only-signing-value',
};

beforeEach(() => {
  dnsLookup.mockReset();
  net.requests.length = 0;
  net.responses.length = 0;
});

describe('handleWebhook — redirects are re-validated hop by hop', () => {
  it.each([
    ['http://127.0.0.1/admin', 'a loopback literal'],
    ['http://169.254.169.254/latest/meta-data', 'the metadata literal'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'an IPv6 literal (refused by the single-label rule)'],
    ['https://nat64.example.com/', 'a name whose AAAA is NAT64 to the metadata address'],
    ['http://admin.localhost/', 'a .localhost name'],
    ['https://internal.example.com/', 'a name that resolves privately'],
  ])('blocks a redirect to %s (%s) and never requests it', async (location) => {
    dnsTable({
      'hooks.example.com': ['93.184.216.34'],
      'internal.example.com': ['10.0.0.7'],
      'nat64.example.com': ['64:ff9b::a9fe:a9fe'],
    });
    net.responses.push({ status: 302, location });
    await expect(run(SIGNED)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(net.requests).toHaveLength(1);
  });

  it('a name that rebinds to a private address between hops is blocked on the next hop', async () => {
    dnsLookup
      .mockResolvedValueOnce(answers('93.184.216.34'))
      .mockResolvedValueOnce(answers('10.0.0.9'));
    net.responses.push({ status: 302, location: '/again' });
    await expect(run(SIGNED)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(net.requests).toHaveLength(1);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
  });

  it('pins every hop to the address validated for that hop', async () => {
    dnsTable({ 'hooks.example.com': ['93.184.216.34'], 'other.example.net': ['1.1.1.1'] });
    net.responses.push({ status: 302, location: 'https://other.example.net/next' });
    await run(SIGNED);
    expect(net.requests.map((r) => [r.url, r.connectAll, r.connectSingle])).toEqual([
      [
        'https://hooks.example.com/start',
        [{ address: '93.184.216.34', family: 4 }],
        '93.184.216.34',
      ],
      ['https://other.example.net/next', [{ address: '1.1.1.1', family: 4 }], '1.1.1.1'],
    ]);
  });

  it('follows at most two redirects', async () => {
    dnsTable({ 'hooks.example.com': ['93.184.216.34'] });
    net.responses.push(
      { status: 302, location: '/a' },
      { status: 302, location: '/b' },
      { status: 302, location: '/c' },
    );
    await expect(run(SIGNED)).rejects.toMatchObject({ code: 'HTTP_302' });
    expect(net.requests.map((r) => new URL(r.url).pathname)).toEqual(['/start', '/a', '/b']);
  });

  it('a 302/303 hop becomes a GET without body, content type or signature', async () => {
    dnsTable({ 'hooks.example.com': ['93.184.216.34'] });
    net.responses.push({ status: 303, location: '/done' });
    await run(SIGNED);
    const [first, second] = net.requests;
    expect(first).toMatchObject({ method: 'POST', body: '{"event":"deal.moved"}' });
    expect(first?.headers['x-pravshi-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(second).toMatchObject({ method: 'GET', body: '' });
    expect(Object.keys(second?.headers ?? {}).map((k) => k.toLowerCase())).not.toEqual(
      expect.arrayContaining(['content-type']),
    );
    expect(second?.headers['x-pravshi-signature']).toBeUndefined();
  });

  it('a 307 hop keeps method, body and signature', async () => {
    dnsTable({ 'hooks.example.com': ['93.184.216.34'] });
    net.responses.push({ status: 307, location: '/again' });
    await run(SIGNED);
    const [first, second] = net.requests;
    expect(second).toMatchObject({ method: 'POST', body: first?.body });
    expect(second?.headers['x-pravshi-signature']).toBe(first?.headers['x-pravshi-signature']);
  });
});
