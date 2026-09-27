import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Invitation create/revoke must demand users.create at GLOBAL scope.
 *
 * The invitations RLS policies (0018) require scope_for('users.create') = 'GLOBAL'.
 * Without minScope: 'GLOBAL' on the entry points, a caller holding users.create at a
 * narrower scope would pass the authorization layer and fail later at the database —
 * failing closed, but as a 500 rather than a clean 403. This guard pins the four
 * entry points to the breadth the database demands.
 *
 * Like the other guards this is a heuristic over source text, not a type proof: it
 * fails closed on any shape it does not recognise.
 */

const ENTRY_POINTS = [
  'src/app/api/invitations/route.ts',
  'src/app/api/invitations/[id]/revoke/route.ts',
  'src/app/(app)/admin/users/actions.ts',
] as const;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('invitation entry points require users.create at GLOBAL scope', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file}: every users.create authorization carries minScope GLOBAL`, () => {
      const source = stripComments(readFileSync(join(process.cwd(), file), 'utf8'));

      // Find each authorization spec mentioning users.create and check the spec
      // object it sits in also names minScope: 'GLOBAL'.
      const specPattern = /\{\s*permission:\s*'users\.create'[^}]*\}/g;
      const specs = source.match(specPattern) ?? [];
      expect(specs.length, `${file} should authorize users.create at least once`).toBeGreaterThan(
        0,
      );
      for (const spec of specs) {
        expect(
          spec,
          `${file}: users.create spec must include minScope: 'GLOBAL' — got: ${spec}`,
        ).toMatch(/minScope:\s*'GLOBAL'/);
      }
    });
  }
});
