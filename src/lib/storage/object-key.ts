import { randomUUID } from 'node:crypto';

export interface ObjectKeyInput {
  orgId: string;
  documentId: string;
  versionNo: number;
  /** Accepted for call-site convenience and deliberately ignored — see below. */
  fileName?: string;
}

/**
 * Canonical UUID form. orgId and documentId are `uuid` columns in the schema, so
 * requiring that shape is a restatement of the data model rather than a new rule.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(label: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    // The rejected value is never echoed: it is caller-supplied and may be hostile
    // or sensitive, and an error string is exactly the wrong place for either.
    throw new Error(`objectKey: ${label} must be a UUID`);
  }
  return value.trim().toLowerCase();
}

/**
 * Builds a random, non-guessable R2 object key.
 *
 * The file name is never part of the key. Keys are addresses; a leaked address
 * must reveal nothing about the document, and must be useless without a
 * presigned signature. The display name lives in `document_versions.file_name`.
 *
 * Shape: `<orgId>/<documentId>/<versionNo>/<random uuid>` — always four segments.
 * The prefix is fully determined by its inputs, which is what makes a bucket
 * listing enumerable per org and per document; only the leaf is random, which is
 * what makes an individual object unguessable. Two calls with identical input
 * therefore return different keys, and that is deliberate.
 *
 * orgId and documentId are interpolated into a path, so both are validated as
 * UUIDs first. Without that, a caller passing `../..` would build a key that
 * escapes its own prefix and reads another tenant's namespace — the key would
 * still look well-formed. Validation here does not make the key an authorization
 * mechanism: authorization stays in the application layer, and this only ensures
 * a key cannot address something its inputs did not name.
 */
export function objectKey({ orgId, documentId, versionNo }: ObjectKeyInput): string {
  const org = requireUuid('orgId', orgId);
  const document = requireUuid('documentId', documentId);
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new Error(`objectKey: versionNo must be a positive integer, got ${versionNo}`);
  }
  return `${org}/${document}/${versionNo}/${randomUUID()}`;
}
