import { describe, expect, it } from 'vitest';

import { findSecrets } from '../../scripts/guards/secret-scan.mjs';

const REAL_PAT = 'github_pat_' + 'A'.repeat(24);
// Assembled at runtime, never written as a literal: this file is itself scanned by the
// guard, and a credential-shaped literal here would make the guard fail on its own
// fixtures. Splitting it keeps the source clean without an allow-listed path.
const REAL_DSN =
  ['postgresql://real_user', 's3cr3tpw@ep-live-1.ap-southeast-1.aws.neon.tech'].join(':') +
  '/neondb';

describe('secret-scan allowlist matches TOKENS, not lines (finding #1)', () => {
  it('A. an approved example token alone passes', () => {
    expect(findSecrets('key = "AKIAIOSFODNN7EXAMPLE"')).toHaveLength(0);
    expect(findSecrets("const DIRECT = 'postgresql://u:p@ep-x.aws.neon.tech/db';")).toHaveLength(0);
  });

  it('B. an approved token PLUS a real credential on the same line still fails', () => {
    // This is the exact bypass the line-level allowlist permitted.
    const line = `example = "AKIAIOSFODNN7EXAMPLE" ; real = "${REAL_PAT}"`;
    expect(findSecrets(line).length).toBeGreaterThan(0);

    const dsnLine = `fixture='postgresql://u:p@ep-x.aws.neon.tech/db' live='${REAL_DSN}'`;
    expect(findSecrets(dsnLine).length).toBeGreaterThan(0);
  });

  it('C. a real credential alone fails', () => {
    expect(findSecrets(`token = "${REAL_PAT}"`).length).toBeGreaterThan(0);
    expect(findSecrets(REAL_DSN).length).toBeGreaterThan(0);
    expect(findSecrets('AKIA' + 'ABCDEFGHIJKLMNOP').length).toBeGreaterThan(0);
  });

  it('does not flag a template literal that builds a URL', () => {
    const tmpl = 'return `postgresql://${role}:${encodeURIComponent(pw)}@${host}/${db}`;';
    expect(findSecrets(tmpl)).toHaveLength(0);
  });
});
