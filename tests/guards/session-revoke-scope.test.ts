import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Session revoke/list actions must demand sessions.revoke at GLOBAL scope.
 *
 * Session rows carry no department to scope them to: without a GLOBAL floor, a
 * DEPARTMENT-scoped holder of sessions.revoke could list or revoke any org
 * user's sessions — including a SUPER_ADMIN's. The breadth check therefore
 * belongs on the entry point (a clean 403 SCOPE_DENIED) rather than failing
 * later at the database. This guard pins the three session actions in
 * src/app/(app)/admin/users/actions.ts; the enforcement itself is pinned
 * against a real database in tests/authz/session-revoke-scope.test.ts.
 *
 * Like the other guards this is a heuristic over source text, not a type proof:
 * it fails closed on any shape it does not recognise, and the exact count means
 * a new session action without the floor fails the build.
 */

const ACTIONS = 'src/app/(app)/admin/users/actions.ts';

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('session actions require sessions.revoke at GLOBAL scope', () => {
  it('every sessions.revoke authorization spec carries minScope GLOBAL', () => {
    const source = stripComments(readFileSync(join(process.cwd(), ACTIONS), 'utf8'));
    const specPattern = /\{\s*permission:\s*'sessions\.revoke'[^}]*\}/g;
    const specs = source.match(specPattern) ?? [];
    // getUserSessionsAction, revokeUserSessionAction, revokeAllUserSessionsAction.
    expect(specs.length).toBe(3);
    for (const spec of specs) {
      expect(spec, `sessions.revoke spec must include minScope: 'GLOBAL' — got: ${spec}`).toMatch(
        /minScope:\s*'GLOBAL'/,
      );
    }
  });
});
