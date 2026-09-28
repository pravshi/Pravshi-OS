import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The audit export route must demand audit_logs.view at GLOBAL scope, and must
 * audit the export itself.
 *
 * The audit_logs RLS policy (0011) requires scope_for('audit_logs.view') = 'GLOBAL'.
 * Without minScope: 'GLOBAL' on the route, a caller holding audit_logs.view at a
 * narrower scope would pass the authorization layer and fail later at the database
 * — failing closed, but as a 500 rather than a clean 403. This guard pins the
 * route to the breadth the database demands.
 *
 * Like the other guards this is a heuristic over source text, not a type proof: it
 * fails closed on any shape it does not recognise.
 */

const ROUTE = 'src/app/api/admin/audit-logs/export/route.ts';

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('audit export route authorization', () => {
  const source = stripComments(readFileSync(join(process.cwd(), ROUTE), 'utf8'));

  it('authorizes audit_logs.view at GLOBAL scope', () => {
    const specs = source.match(/\{\s*permission:\s*'audit_logs\.view'[^}]*\}/g) ?? [];
    expect(specs.length, `${ROUTE} should authorize audit_logs.view at least once`).toBeGreaterThan(
      0,
    );
    for (const spec of specs) {
      expect(
        spec,
        `${ROUTE}: audit_logs.view spec must include minScope: 'GLOBAL' — got: ${spec}`,
      ).toMatch(/minScope:\s*'GLOBAL'/);
    }
  });

  it('records a MEDIUM audit.export entry for each export', () => {
    expect(source, `${ROUTE} must write the audit.export action`).toMatch(/'audit\.export'/);
    expect(source, `${ROUTE} must grade the export entry MEDIUM`).toMatch(/severity:\s*'MEDIUM'/);
  });

  it('caps the export and signals truncation', () => {
    expect(source, `${ROUTE} must cap rows at EXPORT_ROW_CAP`).toMatch(/EXPORT_ROW_CAP/);
    expect(source, `${ROUTE} must signal truncation to the client`).toMatch(/X-Export-Truncated/);
  });
});
