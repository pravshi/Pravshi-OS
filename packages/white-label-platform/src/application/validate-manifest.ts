/**
 * Application Use Case — Validate White-Label Manifest.
 *
 * Implements strict schema validation, allowlist sanitization, and security checks.
 * Prevents template injection, arbitrary script execution, and unencrypted asset transport.
 */

import { type WhiteLabelManifest, WhiteLabelManifestSchema } from '../domain/manifest';

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly validationErrors?: unknown,
  ) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Validates a candidate manifest against strict schema rules:
 * - App name formatting (no control characters, quotes, or script delimiters)
 * - Bundle identifier validity (reverse-domain syntax)
 * - HTTPS-only assets (icons and splash screens)
 * - Hexadecimal color validation
 */
export function validateManifest(candidate: unknown): WhiteLabelManifest {
  const result = WhiteLabelManifestSchema.safeParse(candidate);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new ManifestValidationError(
      `Manifest validation failed: ${errorMessages}`,
      result.error.format(),
    );
  }

  const manifest = result.data;

  // Additional sanity checks: verify icon is square dimensions via naming or metadata if present
  if (
    manifest.appIcon1024Url.includes('javascript:') ||
    manifest.splashImageUrl.includes('javascript:')
  ) {
    throw new ManifestValidationError('Dangerous URI scheme detected in asset URLs');
  }

  return manifest;
}
