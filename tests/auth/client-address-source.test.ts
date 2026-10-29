import { describe, expect, it } from 'vitest';
import {
  betterAuthIpAddressOptions,
  CLIENT_ADDRESS_HEADER,
  clientAddressFromHeaders,
  clientAddressSource,
} from '@/lib/auth/client-address';

/**
 * D1 — the client address is read from the header the deployment guarantees, never from one a
 * client controls. On Vercel that is x-vercel-forwarded-for, which Vercel sets itself; a forged
 * x-forwarded-for there changes nothing. Production elsewhere trusts no header at all.
 */
const spoofed = new Headers({
  'x-forwarded-for': '198.51.100.66',
  'x-real-ip': '198.51.100.67',
  'x-vercel-forwarded-for': '203.0.113.9',
});

describe('which header is trusted', () => {
  it('Vercel (production and preview) → x-vercel-forwarded-for', () => {
    expect(clientAddressSource({ VERCEL: '1', NODE_ENV: 'production' })).toBe('vercel');
    expect(clientAddressSource({ VERCEL: '1', NODE_ENV: 'development' })).toBe('vercel');
    expect(CLIENT_ADDRESS_HEADER.vercel).toBe('x-vercel-forwarded-for');
  });

  it('local development, CI and tests → x-forwarded-for', () => {
    expect(clientAddressSource({ NODE_ENV: 'test' })).toBe('development');
    expect(clientAddressSource({ NODE_ENV: 'development' })).toBe('development');
  });

  it('production off Vercel → nothing is trusted', () => {
    expect(clientAddressSource({ NODE_ENV: 'production' })).toBe('none');
    expect(clientAddressSource({ NODE_ENV: 'production', VERCEL: '0' })).toBe('none');
  });
});

describe('what is read', () => {
  it('on Vercel, only Vercel’s own header: forged forwarding headers are ignored', () => {
    expect(clientAddressFromHeaders(spoofed, 'vercel')).toBe('203.0.113.9');
    expect(
      clientAddressFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.66' }), 'vercel'),
    ).toBeNull();
  });

  it('in development, x-forwarded-for', () => {
    expect(clientAddressFromHeaders(spoofed, 'development')).toBe('198.51.100.66');
  });

  it('in unsupported production, nothing — every request shares the unknown bucket', () => {
    expect(clientAddressFromHeaders(spoofed, 'none')).toBeNull();
  });

  it('a value that is not an address is never a key', () => {
    expect(
      clientAddressFromHeaders(new Headers({ 'x-vercel-forwarded-for': 'not-an-ip' }), 'vercel'),
    ).toBeNull();
    expect(
      clientAddressFromHeaders(new Headers({ 'x-vercel-forwarded-for': 'fe80::1%eth0' }), 'vercel'),
    ).toBeNull();
  });
});

describe('Better Auth agrees with the application', () => {
  it('reads the same header, or tracks none', () => {
    expect(betterAuthIpAddressOptions('vercel')).toEqual({
      ipAddressHeaders: ['x-vercel-forwarded-for'],
    });
    expect(betterAuthIpAddressOptions('development')).toEqual({
      ipAddressHeaders: ['x-forwarded-for'],
    });
    // Never disableIpTracking: that turns Better Auth's limiter off. An empty list resolves no
    // address, so every request shares the limiter's one no-trusted-ip bucket.
    expect(betterAuthIpAddressOptions('none')).toEqual({ ipAddressHeaders: [] });
    for (const s of ['vercel', 'development', 'none'] as const) {
      expect(betterAuthIpAddressOptions(s)).not.toHaveProperty('disableIpTracking');
    }
  });
});
