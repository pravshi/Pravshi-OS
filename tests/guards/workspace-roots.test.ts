import { existsSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Redesign Step 7 — the source roots the guards walk.
 *
 * Several guards enumerate source files from a fixed list of roots (src, apps/web/src,
 * apps/worker/src): require-permission-first, session-lookup-choke-point, single-db-path,
 * login-fail-closed, domain-events-wired, no-keepalive, module-boundaries and the phase-11 scan.
 * A new workspace package would be invisible to all of them. This fails when the set of workspace
 * packages changes, so whoever adds one (Step 8 adds packages/*) extends every list on purpose.
 */
const dirs = (p: string) =>
  existsSync(p) ? readdirSync(p).filter((e) => statSync(`${p}/${e}`).isDirectory()) : [];

describe('workspace source roots', () => {
  it('apps/ holds exactly web and worker, each with a src folder', () => {
    expect(
      dirs('apps')
        .filter((d) => d !== 'node_modules')
        .sort(),
    ).toEqual(['web', 'worker']);
    expect(existsSync('apps/web/src')).toBe(true);
    expect(existsSync('apps/worker/src')).toBe(true);
  });

  it('packages/ holds contracts, crm-core, database, observability, platform-core, security, shared-config and shared-services; contracts, crm-core, database, observability, platform-core, security and shared-services have a src folder', () => {
    // Step 8 extracts one package per pull request. A package with source code must extend the
    // source roots every guard walks (see the header); shared-config has none, contracts, crm-core, database, observability, platform-core, security and shared-services have src.
    expect(
      dirs('packages')
        .filter((d) => d !== 'node_modules')
        .sort(),
    ).toEqual([
      'contracts',
      'crm-core',
      'database',
      'observability',
      'platform-core',
      'security',
      'shared-config',
      'shared-services',
    ]);
    expect(existsSync('packages/contracts/src')).toBe(true);
    expect(existsSync('packages/crm-core/src')).toBe(true);
    expect(existsSync('packages/database/src')).toBe(true);
    expect(existsSync('packages/observability/src')).toBe(true);
    expect(existsSync('packages/platform-core/src')).toBe(true);
    expect(existsSync('packages/security/src')).toBe(true);
    expect(existsSync('packages/shared-services/src')).toBe(true);
    expect(existsSync('packages/shared-config/src')).toBe(false);
  });
});
