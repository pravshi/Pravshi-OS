import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/rate-limit', () => ({
  checkIpRateLimit: vi.fn(),
}));

vi.mock('@/lib/integrations/inbound', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/integrations/inbound')>();
  return { ...actual, receiveInbound: vi.fn() };
});

import { POST } from '@/app/api/integrations/inbound/[endpointKey]/route';
import { checkIpRateLimit } from '@/lib/auth/rate-limit';
import { hashEndpointKey, receiveInbound, rejectionResult } from '@/lib/integrations/inbound';

/**
 * F-11-08 — the inbound route's throttle, behaviourally and DB-free: the
 * limiter and the receiver are stubbed, so what is pinned here is the
 * route's own wiring — bucket keys, contract allowances, short-circuit
 * order, and the uniform over-limit answer. The substrate's real counting
 * (and the full flood) executes against a database in
 * tests/integrations/security.test.ts (case I10, CI).
 */

const KEY = 'a-valid-endpoint-key-for-tests';
const limit = vi.mocked(checkIpRateLimit);
const receive = vi.mocked(receiveInbound);

const post = (ip?: string) =>
  POST(
    new Request(`http://localhost:3000/api/integrations/inbound/${KEY}`, {
      method: 'POST',
      headers: ip === undefined ? {} : { 'x-forwarded-for': ip },
      body: '{}',
    }),
    { params: Promise.resolve({ endpointKey: KEY }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  receive.mockResolvedValue({ httpStatus: 200, body: { status: 'accepted' } });
});

describe('inbound route rate limiting (F-11-08)', () => {
  it('checks the per-IP bucket (300/min) then the per-endpoint bucket (60/min), keyed by digest', async () => {
    limit.mockResolvedValue(true);
    const res = await post('198.51.100.9');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenNthCalledWith(1, 'inbound:ip:198.51.100.9', 300, 60);
    expect(limit).toHaveBeenNthCalledWith(2, `inbound:ep:${hashEndpointKey(KEY)}`, 60, 60);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('an over-limit IP is refused 429 with the uniform body; the endpoint bucket is never consulted', async () => {
    limit.mockImplementation(async (key: string) => !key.startsWith('inbound:ip:'));
    const res = await post('198.51.100.9');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(rejectionResult().body);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
  });

  it('an over-limit endpoint is refused 429 with the uniform body; the receiver never runs', async () => {
    limit.mockImplementation(async (key: string) => !key.startsWith('inbound:ep:'));
    const res = await post('198.51.100.9');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(rejectionResult().body);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(receive).not.toHaveBeenCalled();
  });

  it('a request with no forwarding header lands in the unknown-IP bucket', async () => {
    limit.mockResolvedValue(true);
    const res = await post();
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenNthCalledWith(1, 'inbound:ip:unknown', 300, 60);
  });
});
