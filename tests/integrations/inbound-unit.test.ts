import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptedResult,
  decideDedup,
  endpointKeyHashesEqual,
  extractExternalEventId,
  generateEndpointKey,
  hashEndpointKey,
  hashPayload,
  INBOUND_DEDUP_WINDOW_HOURS,
  isBodyWithinCap,
  rejectionResult,
  verifyInboundRequest,
  ENDPOINT_KEY_PATTERN,
  type ExistingReceipt,
} from '@/lib/integrations/inbound';

/**
 * Wave W-in — DB-free unit tests for the inbound receiver's pure parts
 * (contract §4.4/§4.5): token generation + hashing, the constant-time
 * verification step in both registry modes, external-event-id extraction,
 * the dedup decision table, body-cap enforcement, and the uniform response
 * shapes. Everything that touches the database (resolution, receipt
 * writes, dispatch) is Wave J's DB suite — the Nov-1 rule forbids running
 * it locally, and this file must never open a connection.
 */

const CAP = 256 * 1024;

describe('endpoint keys', () => {
  it('generates 256-bit base64url tokens in the stored pattern', () => {
    const key = generateEndpointKey();
    expect(key).toMatch(ENDPOINT_KEY_PATTERN);
    expect(key).toHaveLength(43);
    // Two generations never collide in practice.
    expect(generateEndpointKey()).not.toBe(key);
  });

  it('hashes to the SHA-256 hex digest that is stored', () => {
    const key = generateEndpointKey();
    expect(hashEndpointKey(key)).toBe(createHash('sha256').update(key, 'utf8').digest('hex'));
    expect(hashEndpointKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes payloads the same way (the only body trace stored)', () => {
    expect(hashPayload('{"a":1}')).toBe(
      createHash('sha256').update('{"a":1}', 'utf8').digest('hex'),
    );
  });
});

describe('endpointKeyHashesEqual — the constant-time verification step', () => {
  const hash = hashEndpointKey('some-endpoint-key');

  it('accepts identical digests', () => {
    expect(endpointKeyHashesEqual(hash, hash)).toBe(true);
  });

  it('rejects a different digest', () => {
    expect(endpointKeyHashesEqual(hash, hashEndpointKey('another-key'))).toBe(false);
  });

  it('rejects malformed input instead of throwing', () => {
    expect(endpointKeyHashesEqual('not-hex', hash)).toBe(false);
    expect(endpointKeyHashesEqual(hash, 'abc')).toBe(false);
    expect(endpointKeyHashesEqual('', '')).toBe(false);
    expect(endpointKeyHashesEqual(hash.toUpperCase(), hash)).toBe(false);
  });
});

describe('verifyInboundRequest', () => {
  const stored = hashEndpointKey('the-real-key');

  it('endpoint-token mode: presented digest must match the stored digest', () => {
    expect(
      verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: stored,
        rawBody: '{}',
      }),
    ).toBe(true);
    expect(
      verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: hashEndpointKey('a-guess'),
        storedEndpointKeyHash: stored,
        rawBody: '{}',
      }),
    ).toBe(false);
  });

  it('endpoint-token mode: no stored digest (no key issued) never verifies', () => {
    expect(
      verifyInboundRequest({
        mode: 'endpoint-token',
        presentedEndpointKeyHash: stored,
        storedEndpointKeyHash: null,
        rawBody: '{}',
      }),
    ).toBe(false);
  });

  it('hmac-sha256 mode: HMAC over the raw body, constant-time compared', () => {
    const secret = 'provider-secret';
    const rawBody = '{"event":"ping"}';
    const signature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const base = {
      mode: 'hmac-sha256' as const,
      presentedEndpointKeyHash: stored,
      storedEndpointKeyHash: stored,
      rawBody,
      secret,
    };
    expect(verifyInboundRequest({ ...base, signatureHeader: `sha256=${signature}` })).toBe(true);
    expect(verifyInboundRequest({ ...base, signatureHeader: signature })).toBe(true);
    // A body tampered after signing fails.
    expect(
      verifyInboundRequest({ ...base, rawBody: '{"event":"pong"}', signatureHeader: signature }),
    ).toBe(false);
    // Missing secret or signature fails closed.
    expect(verifyInboundRequest({ ...base, secret: null, signatureHeader: signature })).toBe(false);
    expect(verifyInboundRequest({ ...base, signatureHeader: null })).toBe(false);
    expect(verifyInboundRequest({ ...base, signatureHeader: 'sha256=zz' })).toBe(false);
  });
});

describe('extractExternalEventId', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('prefers the conventional id headers, in order', () => {
    expect(extractExternalEventId(headers({ 'x-event-id': 'evt_1' }), null)).toBe('evt_1');
    expect(extractExternalEventId(headers({ 'x-webhook-id': 'evt_2' }), null)).toBe('evt_2');
    expect(extractExternalEventId(headers({ 'idempotency-key': 'evt_3' }), null)).toBe('evt_3');
    expect(
      extractExternalEventId(headers({ 'x-event-id': 'evt_1', 'x-webhook-id': 'evt_2' }), {
        id: 'evt_body',
      }),
    ).toBe('evt_1');
  });

  it('falls back to a top-level string id in a JSON object body', () => {
    expect(extractExternalEventId(headers({}), { id: 'evt_body' })).toBe('evt_body');
    expect(extractExternalEventId(headers({}), { id: 42 })).toBeNull();
    expect(extractExternalEventId(headers({}), [{ id: 'evt_array' }])).toBeNull();
    expect(extractExternalEventId(headers({}), 'a string body')).toBeNull();
    expect(extractExternalEventId(headers({}), null)).toBeNull();
  });

  it('ignores over-long ids rather than truncating them into collisions', () => {
    const long = 'x'.repeat(257);
    expect(extractExternalEventId(headers({ 'x-event-id': long }), null)).toBeNull();
    expect(extractExternalEventId(headers({}), { id: long })).toBeNull();
    expect(extractExternalEventId(headers({ 'x-event-id': '   ' }), null)).toBeNull();
  });
});

describe('decideDedup — the dedup decision table', () => {
  const receipt = (over: Partial<ExistingReceipt>): ExistingReceipt => ({
    receiptId: '11111111-1111-1111-1111-111111111111',
    status: 'PROCESSED',
    matchKind: 'external',
    ...over,
  });

  it('no existing receipt → process', () => {
    expect(decideDedup(null)).toEqual({ action: 'process' });
  });

  it('payload-hash match inside the window → duplicate, whatever its status', () => {
    expect(decideDedup(receipt({ matchKind: 'payload', status: 'PROCESSED' }))).toEqual({
      action: 'duplicate',
    });
    expect(decideDedup(receipt({ matchKind: 'payload', status: 'RECEIVED' }))).toEqual({
      action: 'duplicate',
    });
  });

  it('external match on a completed receipt → duplicate, never reprocess', () => {
    expect(decideDedup(receipt({ status: 'PROCESSED' }))).toEqual({ action: 'duplicate' });
    expect(decideDedup(receipt({ status: 'DUPLICATE' }))).toEqual({ action: 'duplicate' });
  });

  it('external match on an incomplete receipt → reprocess that very row', () => {
    for (const status of [
      'FAILED',
      'RECEIVED',
      'REJECTED_SIGNATURE',
      'REJECTED_VALIDATION',
    ] as const) {
      expect(decideDedup(receipt({ status }))).toEqual({
        action: 'reprocess',
        receiptId: '11111111-1111-1111-1111-111111111111',
      });
    }
  });

  it('documents the dedup window the 0058 definer enforces', () => {
    expect(INBOUND_DEDUP_WINDOW_HOURS).toBe(24);
  });
});

describe('isBodyWithinCap — enforced before parsing (§4.4)', () => {
  it('accepts bodies at and under the cap, rejects over it', () => {
    expect(isBodyWithinCap('', CAP)).toBe(true);
    expect(isBodyWithinCap('x'.repeat(CAP), CAP)).toBe(true);
    expect(isBodyWithinCap('x'.repeat(CAP + 1), CAP)).toBe(false);
  });

  it('counts bytes, not characters (multibyte bodies)', () => {
    // '€' is 3 bytes in UTF-8: 10 chars = 30 bytes.
    expect(isBodyWithinCap('€'.repeat(10), 29)).toBe(false);
    expect(isBodyWithinCap('€'.repeat(10), 30)).toBe(true);
  });
});

describe('uniform response shapes (§4.4)', () => {
  it('acceptance is one 200 shape for every completed outcome', () => {
    expect(acceptedResult()).toEqual({ httpStatus: 200, body: { status: 'accepted' } });
  });

  it('rejection is one 400 shape that names no reason', () => {
    const result = rejectionResult();
    expect(result.httpStatus).toBe(400);
    expect(result.body).toEqual({
      error: { code: 'INBOUND_REJECTED', message: 'The webhook delivery was rejected.' },
    });
    // The shape must not leak which check failed: no status/reason fields.
    expect(JSON.stringify(result.body)).not.toMatch(/signature|unknown|disabled|oversize/i);
  });
});
