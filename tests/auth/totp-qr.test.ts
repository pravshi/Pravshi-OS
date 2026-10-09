import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import { qrPathData } from '@/components/security/totp-qr-code';

/**
 * The TOTP enrolment QR encoder (AUD-21) — DB-free verification of the new
 * uqr dependency against the QR format's own invariants.
 *
 * A QR encoder cannot be validated by eyeballing: a subtly wrong matrix
 * looks identical and scans as garbage. So these tests assert the structural
 * properties every valid QR symbol must have — module count from the
 * version, the three finder patterns with their separators, and the timing
 * patterns — plus determinism, which together pin the encoder's output far
 * tighter than a snapshot of an image would.
 */
const OTP_URI =
  'otpauth://totp/Pravshi%20OS:nani%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Pravshi%20OS&algorithm=SHA1&digits=6&period=30';

describe('uqr encoder (as wired for TOTP enrolment)', () => {
  it('produces a square matrix whose size matches its QR version', () => {
    const qr = encode(OTP_URI, { ecc: 'M', border: 2 });
    expect(qr.data.length).toBe(qr.size);
    for (const row of qr.data) expect(row.length).toBe(qr.size);
    // Symbol size is 4*version + 17 modules; the border adds 2 per side.
    expect(qr.size).toBe(4 * qr.version + 17 + 4);
    expect(qr.version).toBeGreaterThanOrEqual(1);
    expect(qr.version).toBeLessThanOrEqual(40);
  });

  it('is deterministic — the same URI always yields the same symbol', () => {
    const a = encode(OTP_URI, { ecc: 'M', border: 2 });
    const b = encode(OTP_URI, { ecc: 'M', border: 2 });
    expect(a.data).toEqual(b.data);
  });

  it('draws the three finder patterns with light separators', () => {
    const border = 2;
    const { data, size } = encode(OTP_URI, { ecc: 'M', border });
    const at = (x: number, y: number) => data[y]![x]!;

    for (const origin of [
      [border, border], // top-left
      [size - border - 7, border], // top-right
      [border, size - border - 7], // bottom-left
    ]) {
      const ox = origin[0]!;
      const oy = origin[1]!;
      // 7x7 finder: dark ring, light ring, 3x3 dark core.
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          expect(at(ox + dx, oy + dy)).toBe(ring || core);
        }
      }
    }
    // The separator row/column beside the top-left finder is light, and the
    // quiet zone (border) is light throughout.
    for (let i = 0; i < 8; i += 1) {
      expect(at(border + i, border + 7)).toBe(false);
      expect(at(border + 7, border + i)).toBe(false);
    }
    expect(at(0, 0)).toBe(false);
    expect(at(size - 1, size - 1)).toBe(false);
  });

  it('draws alternating timing patterns between the finders', () => {
    const border = 2;
    const { data } = encode(OTP_URI, { ecc: 'M', border });
    // Timing lives on row/column 6 of the symbol (inside the border offset),
    // running between the finder separators: dark on even offsets.
    for (let i = 8; i < 16; i += 1) {
      expect(data[border + 6]![border + i]).toBe(i % 2 === 0);
      expect(data[border + i]![border + 6]).toBe(i % 2 === 0);
    }
  });
});

describe('qrPathData (the SVG rendering of the matrix)', () => {
  it('merges horizontal runs and skips light modules', () => {
    const matrix = [
      [true, true, false, true],
      [false, false, false, false],
      [true, false, false, false],
    ];
    expect(qrPathData(matrix)).toBe('M0 0h2v1H0zM3 0h1v1H3zM0 2h1v1H0z');
  });

  it('renders an all-light matrix as an empty path', () => {
    expect(qrPathData([[false, false]])).toBe('');
  });
});
