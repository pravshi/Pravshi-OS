'use client';

import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * The TOTP enrolment QR code (AUD-21).
 *
 * Until now /me/security showed the otpauth:// URI as raw text with a copy
 * button — every enrolment meant typing or pasting a long secret into the
 * authenticator app by hand. This renders the same URI as a scannable QR
 * code, alongside the raw URI (which stays: it is the fallback for desktop
 * authenticator apps and the only option when the camera is the same device).
 *
 * The encoder is uqr — zero-dependency, single-purpose — and only its module
 * matrix is consumed: the SVG is built here, so no generated markup is ever
 * injected into the page. ECC level M: the code is displayed on screen at a
 * generous size, and M keeps the module count (and scan time) lower than Q/H
 * for the ~120-character enrolment URI.
 */

/** One SVG path covering every dark module, merging horizontal runs. */
export function qrPathData(data: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < data.length; y += 1) {
    const row = data[y]!;
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end += 1;
      parts.push(`M${x} ${y}h${end - x + 1}v1H${x}z`);
      x = end + 1;
    }
  }
  return parts.join('');
}

export function TotpQrCode({ uri, size = 176 }: { uri: string; size?: number }) {
  const qr = useMemo(() => {
    try {
      return encode(uri, { ecc: 'M', border: 2 });
    } catch {
      return null;
    }
  }, [uri]);

  if (!qr) return null;

  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="rounded bg-white p-1"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qrPathData(qr.data)} fill="#000000" />
    </svg>
  );
}
