import { describe, expect, it } from 'vitest';
import { objectKey } from '@/lib/storage/object-key';

const base = {
  orgId: '33333333-3333-3333-3333-333333333333',
  documentId: '44444444-4444-4444-4444-444444444444',
  versionNo: 1,
};

describe('objectKey', () => {
  it('namespaces by org, document and version', () => {
    expect(objectKey(base)).toMatch(
      /^33333333-3333-3333-3333-333333333333\/44444444-4444-4444-4444-444444444444\/1\/[0-9a-f-]{36}$/,
    );
  });

  it('never embeds the file name — a filename is metadata, not an address', () => {
    const key = objectKey({ ...base, fileName: 'rahul-offer-letter.pdf' });
    expect(key).not.toContain('rahul');
    expect(key).not.toContain('.pdf');
  });

  it('produces a different key every call, so keys are not guessable', () => {
    expect(objectKey(base)).not.toBe(objectKey(base));
  });

  it('rejects a non-positive version', () => {
    expect(() => objectKey({ ...base, versionNo: 0 })).toThrow(/versionNo/);
  });
});

// ── Beyond the plan's four cases ────────────────────────────────────────────
// The plan validates versionNo only. orgId and documentId are interpolated
// straight into a path, so a caller passing an unvalidated value would build a
// traversing key. These identifiers are uuid columns in the schema, so requiring
// a UUID is the narrowest check that closes it without changing the key format.

describe('objectKey identifier validation', () => {
  const traversals = [
    '../../etc/passwd',
    '..',
    'a/b',
    '33333333-3333-3333-3333-333333333333/../..',
    '%2e%2e%2f',
    'x\y',
  ];

  it('rejects path traversal in orgId', () => {
    for (const orgId of traversals) {
      expect(() => objectKey({ ...base, orgId }), orgId).toThrow(/orgId/);
    }
  });

  it('rejects path traversal in documentId', () => {
    for (const documentId of traversals) {
      expect(() => objectKey({ ...base, documentId }), documentId).toThrow(/documentId/);
    }
  });

  it('rejects empty or whitespace identifiers', () => {
    for (const bad of ['', '   ', '\t']) {
      expect(() => objectKey({ ...base, orgId: bad })).toThrow(/orgId/);
      expect(() => objectKey({ ...base, documentId: bad })).toThrow(/documentId/);
    }
  });

  it('rejects a non-UUID identifier even when it is path-safe', () => {
    expect(() => objectKey({ ...base, orgId: 'acme-corp' })).toThrow(/orgId/);
    expect(() => objectKey({ ...base, documentId: '12345' })).toThrow(/documentId/);
  });

  it('accepts a uppercase UUID and normalises it to lower case', () => {
    const key = objectKey({ ...base, orgId: base.orgId.toUpperCase() });
    expect(key.startsWith(`${base.orgId}/`)).toBe(true);
  });

  it('rejects a non-integer, negative or non-finite version', () => {
    for (const versionNo of [1.5, -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => objectKey({ ...base, versionNo })).toThrow(/versionNo/);
    }
  });

  it('always produces exactly four path segments', () => {
    expect(objectKey(base).split('/')).toHaveLength(4);
  });

  it('leaks nothing from the ignored fileName, including traversal attempts', () => {
    const key = objectKey({ ...base, fileName: '../../../secret.pdf' });
    expect(key).not.toContain('..');
    expect(key).not.toContain('secret');
    expect(key.split('/')).toHaveLength(4);
  });
});
