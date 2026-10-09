import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 11 (Security Hardening), Wave J — companion to
 * tests/security/phase11-adversarial.test.ts: the parts of the coverage
 * matrix that are behavioural without a database, plus the static
 * retirement assertions.
 *
 *   F-11-09  Search / audit-export throttles. Wave D pinned the constants
 *            and envelopes structurally (tests/guards/
 *            security-headers-ratelimit.test.ts). Here the REAL route
 *            handlers run with the limiter and the services stubbed —
 *            the inbound-ratelimit.test.ts idiom — pinning what only the
 *            route itself can prove: the limiter is consulted FIRST,
 *            with the contracted per-user bucket and allowance, and a
 *            refusal answers 429 in the module's envelope while the
 *            expensive service never runs.
 *   F-11-11  The legacy test-project-scope workflow (which wired a
 *            project-creating NEON_API_KEY Actions secret) is deleted
 *            and unreferenced on every functional surface.
 *   F-11-14  The dormant migrations 0051_reports_view_permission.sql and
 *            0040_invitation_role_lookup.sql are deleted, unjournaled
 *            (as they always were) and unreferenced.
 *
 * DB-free: runs locally and in CI alike.
 */

const FAKE_AUTH = {
  ctx: { personId: 'person-1', orgId: 'org-1', aal: 'aal1' },
  meta: { requestId: 'req-1' },
};

vi.mock('@/lib/authz/http', () => ({
  withPermission:
    (_opts: unknown, handler: (req: Request, auth: typeof FAKE_AUTH) => Promise<Response>) =>
    (req: Request): Promise<Response> =>
      handler(req, FAKE_AUTH),
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  checkIpRateLimit: vi.fn(),
}));

vi.mock('@/lib/search/query', () => ({
  searchGlobal: vi.fn(),
}));

vi.mock('@/lib/admin/audit-export', () => ({
  EXPORT_ROW_CAP: 10000,
  AUDIT_CSV_HEADER: 'id,created_at',
  countAuditExportRows: vi.fn(),
  streamAuditExportBatches: vi.fn(async () => undefined),
  auditRecordToCsvRow: vi.fn(() => ''),
  auditRecordToJson: vi.fn(() => ({})),
}));

vi.mock('@/lib/audit/log', () => ({
  requestMetadata: vi.fn(() => ({})),
  writeAuditEntry: vi.fn(async () => undefined),
}));

import { GET as searchGET } from '@/app/api/search/route';
import { GET as exportGET } from '@/app/api/admin/audit-logs/export/route';
import { checkIpRateLimit } from '@/lib/auth/rate-limit';
import { searchGlobal } from '@/lib/search/query';
import { countAuditExportRows } from '@/lib/admin/audit-export';

const limit = vi.mocked(checkIpRateLimit);
const search = vi.mocked(searchGlobal);
const countExport = vi.mocked(countAuditExportRows);

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue({ results: [], total: 0 } as never);
  countExport.mockResolvedValue(0);
});

describe('F-11-09: the search route throttles per user before searching', () => {
  const get = () =>
    searchGET(new Request('http://localhost:3000/api/search?q=acme'), {
      params: Promise.resolve({}),
    });

  it('consults the limiter first with the contracted bucket (search:user:<person>, 120/min)', async () => {
    limit.mockResolvedValue(true);
    const res = await get();
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith('search:user:person-1', 120, 60);
    expect(search).toHaveBeenCalledTimes(1);
    expect(limit.mock.invocationCallOrder[0]!).toBeLessThan(search.mock.invocationCallOrder[0]!);
  });

  it('a refusal answers 429 RATE_LIMITED in the module envelope and the search never runs', async () => {
    limit.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('F-11-09: the audit-log export throttles per user before counting or streaming', () => {
  const get = () =>
    exportGET(new Request('http://localhost:3000/api/admin/audit-logs/export'), {
      params: Promise.resolve({}),
    });

  it('consults the limiter first with the contracted bucket (audit-export:user:<person>, 5/min)', async () => {
    limit.mockResolvedValue(true);
    const res = await get();
    expect(res.status).toBe(200);
    expect(limit).toHaveBeenCalledWith('audit-export:user:person-1', 5, 60);
    expect(countExport).toHaveBeenCalledTimes(1);
    expect(limit.mock.invocationCallOrder[0]!).toBeLessThan(
      countExport.mock.invocationCallOrder[0]!,
    );
  });

  it('a refusal answers 429 RATE_LIMITED in the module envelope and no export work starts', async () => {
    limit.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(countExport).not.toHaveBeenCalled();
  });
});

/* ── F-11-11 / F-11-14: the retirements are real and total ─────────────── */

const ROOT = process.cwd();
const RETIRED_WORKFLOW = '.github/workflows/test-project-scope.yml';
const RETIRED_MIGRATIONS = [
  'drizzle/0051_reports_view_permission.sql',
  'drizzle/0040_invitation_role_lookup.sql',
];
const RETIRED_NAMES = [
  'test-project-scope',
  '0051_reports_view_permission',
  '0040_invitation_role_lookup',
];

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.sql',
  '.yml',
  '.yaml',
  '.md',
]);
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if ([...TEXT_EXTENSIONS].some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
};

describe('F-11-11 / F-11-14: retired files are absent and unreferenced', () => {
  it('the legacy workflow and both dormant migrations do not exist', () => {
    expect(existsSync(join(ROOT, RETIRED_WORKFLOW))).toBe(false);
    for (const file of RETIRED_MIGRATIONS) {
      expect(existsSync(join(ROOT, file))).toBe(false);
    }
    // The journaled neighbours survive: exactly one 0040 (the pipeline
    // stage membership guard) and no 0051 at all.
    const drizzleFiles = readdirSync(join(ROOT, 'drizzle'));
    expect(drizzleFiles.filter((f) => f.startsWith('0040_'))).toEqual([
      '0040_pipeline_stage_membership_guard.sql',
    ]);
    expect(drizzleFiles.filter((f) => f.startsWith('0051_'))).toEqual([]);
    expect(existsSync(join(ROOT, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(join(ROOT, '.github/workflows/direct-push-audit.yml'))).toBe(true);
  });

  it('the migration journal never referenced the dormant files', () => {
    const journal = JSON.parse(readFileSync(join(ROOT, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).not.toContain('0051_reports_view_permission');
    expect(tags).not.toContain('0040_invitation_role_lookup');
  });

  it('no functional surface references the retired names', () => {
    // Scope: the surfaces that could ACT on a reference — workflows,
    // migrations + journal, scripts, app source, root manifests. (This
    // test file names them by design and lives outside the scope; Wave
    // M's phase doc may narrate the retirement without reviving it.)
    const surfaces = [
      ...walk(join(ROOT, '.github')),
      ...walk(join(ROOT, 'drizzle')),
      ...walk(join(ROOT, 'scripts')),
      ...walk(join(ROOT, 'src')),
      join(ROOT, 'package.json'),
      join(ROOT, 'pnpm-workspace.yaml'),
    ];
    const offenders: string[] = [];
    for (const file of surfaces) {
      const text = readFileSync(file, 'utf8');
      for (const name of RETIRED_NAMES) {
        if (text.includes(name)) offenders.push(`${file} → ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
