import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyseRoute, analyseServerActions } from './require-permission-first.test';
import {
  CreateCompanySchema,
  CreateContactSchema,
  CreateDealSchema,
  DEAL_STAGES,
  DealStageSchema,
  ListDealsQuerySchema,
  ListQuerySchema,
  UpdateCompanySchema,
} from '@/lib/crm/schema';

/**
 * Phase 2 — CRM Core guards.
 *
 * Source-text heuristics in the style of the other guard tests, plus unit checks on the
 * zod boundary. They lock in the contract the UI Engineer builds against:
 *
 *  1. every service takes an Authorization only requirePermission() can issue, as its
 *     first parameter, and reaches Postgres only through withAuthorizedDb()
 *  2. every exported server action and route handler authorizes first
 *     (requirePermission / withPermission), with the right permission key
 *  3. no hard delete anywhere in the CRM code; soft delete is deleted_at = now() only,
 *     never cleared
 *  4. created_by/updated_by are never written — the trigger owns them
 *  5. owner_person_id/org_id never come from client input
 *  6. untrusted input is zod-validated before any query; limits are capped at 100
 */

const SERVICE_FILES = [
  'src/lib/crm/companies.ts',
  'src/lib/crm/contacts.ts',
  'src/lib/crm/deals.ts',
] as const;

const ACTION_FILE = 'src/app/(app)/crm/actions.ts';

const ROUTE_FILES = [
  'src/app/api/crm/companies/route.ts',
  'src/app/api/crm/companies/[id]/route.ts',
  'src/app/api/crm/contacts/route.ts',
  'src/app/api/crm/contacts/[id]/route.ts',
  'src/app/api/crm/deals/route.ts',
  'src/app/api/crm/deals/[id]/route.ts',
] as const;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (file: string) => readFileSync(file, 'utf8');

describe('CRM services reach Postgres only through withAuthorizedDb()', () => {
  for (const file of SERVICE_FILES) {
    it(`${file} imports withAuthorizedDb and nothing that bypasses it`, () => {
      const code = stripComments(read(file));
      expect(code).toMatch(/from '@\/lib\/db\/authorized'/);
      expect(code).not.toMatch(/from '@\/lib\/db\/pool'/);
      expect(code).not.toMatch(/from '@\/lib\/db\/auth-client'/);
      expect(code).not.toMatch(/pool\.connect\(/);
    });

    it(`${file}: every exported function takes Authorization first`, () => {
      const code = stripComments(read(file));
      const fns = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)];
      expect(fns.length).toBeGreaterThan(0);
      for (const [, name, params] of fns) {
        expect((params ?? '').trim(), name).toMatch(/^auth:\s*Authorization/);
      }
    });

    it(`${file}: validates untrusted input with a zod schema before querying`, () => {
      const code = stripComments(read(file));
      const fns = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)];
      for (const [, name, params] of fns) {
        if (!/\binput\b/.test(params ?? '')) continue; // get*/delete* take only an id
        const start = code.indexOf(`function ${name}`);
        const bodyStart = code.indexOf('{', start);
        const rest = code.slice(bodyStart);
        const nextExport = rest.search(/\nexport\s+async\s+function/);
        const fnBody = nextExport === -1 ? rest : rest.slice(0, nextExport);
        expect(fnBody, `${name} must call Schema.parse(input)`).toMatch(
          /(Create|Update|List)\w*Schema\.parse\(/,
        );
      }
    });

    it(`${file}: no hard DELETE, and deleted_at is set but never cleared`, () => {
      const code = stripComments(read(file));
      expect(code).not.toMatch(/\bdelete\s+from\b/i);
      expect(code).not.toMatch(/deleted_at\s*=\s*null/i);
      // soft deletes stamp the clock, they do not take it from input
      expect(code).toMatch(/deleted_at\s*=\s*now\(\)/i);
    });

    it(`${file}: never writes created_by/updated_by or client-supplied identity`, () => {
      const code = stripComments(read(file));
      expect(code).not.toMatch(/created_by/);
      expect(code).not.toMatch(/updated_by/);
      // the schemas carry no org/owner fields, and nothing reads them off input
      expect(code).not.toMatch(/\bdata\.(orgId|ownerPersonId)\b/);
      expect(code).not.toMatch(/\binput\.(orgId|ownerPersonId)\b/);
      // identity comes from the Authorization, in the INSERT column list
      expect(code).toMatch(/auth\.ctx\.personId/);
      expect(code).toMatch(/auth\.ctx\.orgId/);
    });
  }
});

describe('CRM entry points authorize first', () => {
  it('every CRM server action awaits requirePermission() as its first statement', () => {
    expect(analyseServerActions(read(ACTION_FILE))).toEqual([]);
  });

  it('CRM actions use the view/create/edit permission triple, nothing else', () => {
    const code = stripComments(read(ACTION_FILE));
    const keys = [...code.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(0);
    const allowed = new Set([
      'companies.view',
      'companies.create',
      'companies.edit',
      'contacts.view',
      'contacts.create',
      'contacts.edit',
      'deals.view',
      'deals.create',
      'deals.edit',
    ]);
    for (const key of keys) expect(allowed.has(key), key).toBe(true);
    // reads gate on .view, creates on .create, updates and soft deletes on .edit
    expect(code).toMatch(/permission: 'companies\.view'/);
    expect(code).toMatch(/permission: 'deals\.create'/);
    expect(code).toMatch(/permission: 'contacts\.edit'/);
  });

  it('every CRM route handler is built as withPermission(...)', () => {
    for (const file of ROUTE_FILES) {
      expect(analyseRoute(read(file)), file).toEqual([]);
    }
  });

  it('CRM routes reject invalid input with 400, not the 500 envelope', () => {
    for (const file of ROUTE_FILES) {
      expect(stripComments(read(file)), file).toMatch(/invalidRequestResponse/);
    }
  });
});

describe('export endpoints (F5): gated, audited and throttled — or absent', () => {
  /**
   * `contacts.export` / `deals.export` are action permissions with ZERO database
   * enforcement: RLS cannot distinguish a bulk export from a paginated read, so the
   * API layer is the only enforcement point. No export endpoint exists yet (exports
   * were deferred in the Phase 2 contract) — this tripwire fails the build the moment
   * one is added without all three protections:
   *
   *   1. requirePermission('contacts.export' | 'deals.export') FIRST
   *      (authorizes-first is additionally enforced by require-permission-first.test.ts)
   *   2. writeAuditEntry() for every export — exports are app-layer audit intent
   *   3. checkIpRateLimit() throttle, the Phase 1 invitation pattern:
   *      checkIpRateLimit(ipRateLimitKey('<route>', clientIp(request)), max, windowSeconds)
   *      from @/lib/auth/rate-limit, answering 429 { error: 'RATE_LIMITED' }
   */

  /** Route files that ARE export endpoints: an /export/ path segment or an *export* handler. */
  function exportRouteFiles(): string[] {
    return (ROUTE_FILES as readonly string[]).filter((file) => {
      if (/\/export(\/|$)/.test(file)) return true;
      const code = stripComments(read(file));
      return [...code.matchAll(/export\s+const\s+(\w+)\s*=/g)].some(
        ([, name]) =>
          /export/i.test(name ?? '') &&
          !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name ?? ''),
      );
    });
  }

  /** Server-action names that ARE exports. */
  function exportActionNames(): string[] {
    const code = stripComments(read(ACTION_FILE));
    return [...code.matchAll(/export\s+async\s+function\s+(\w+)/g)]
      .map((m) => m[1] as string)
      .filter((name) => /export/i.test(name));
  }

  it('finds no export endpoints yet — exports are deferred', () => {
    expect(exportRouteFiles()).toEqual([]);
    expect(exportActionNames()).toEqual([]);
  });

  it('the tripwire itself rejects an export handler missing any protection', () => {
    const check = (source: string): string[] => {
      const problems: string[] = [];
      if (!/permission:\s*'(contacts|deals)\.export'/.test(source))
        problems.push('must requirePermission() with contacts.export or deals.export first');
      if (!/\bwriteAuditEntry\s*\(/.test(source))
        problems.push('must writeAuditEntry() for every export');
      if (!/\bcheckIpRateLimit\s*\(/.test(source))
        problems.push('must throttle with checkIpRateLimit()');
      return problems;
    };
    // A bare export with none of the three protections is rejected…
    expect(
      check(`export const GET = withPermission({ permission: 'contacts.view' }, handler);`),
    ).toHaveLength(3);
    // …and one carrying all three passes.
    expect(
      check(`
        export const GET = withPermission({ permission: 'contacts.export' }, async (request, authorization) => {
          if (!(await checkIpRateLimit(ipRateLimitKey('crm:contacts:export', clientIp(request)), 5, 60)))
            return Response.json({ error: 'RATE_LIMITED' }, { status: 429 });
          await writeAuditEntry(authorization.ctx, { action: 'contacts.export', entityType: 'contact', result: 'SUCCESS', severity: 'MEDIUM' }, authorization.meta);
        });`),
    ).toEqual([]);
  });

  it('any future export route carries the export permission, an audit write and a throttle', () => {
    for (const file of exportRouteFiles()) {
      const code = stripComments(read(file));
      expect(analyseRoute(code), file).toEqual([]);
      expect(code, `${file}: must gate on the export permission`).toMatch(
        /permission:\s*'(contacts|deals)\.export'/,
      );
      expect(code, `${file}: must audit every export`).toMatch(/\bwriteAuditEntry\s*\(/);
      expect(code, `${file}: must throttle exports`).toMatch(/\bcheckIpRateLimit\s*\(/);
    }
  });

  it('any future export action carries the export permission, an audit write and a throttle', () => {
    const code = stripComments(read(ACTION_FILE));
    expect(analyseServerActions(code)).toEqual([]);
    for (const name of exportActionNames()) {
      const start = code.indexOf(`function ${name}`);
      const rest = code.slice(code.indexOf('{', start));
      const nextExport = rest.search(/\nexport\s+async\s+function/);
      const fnBody = nextExport === -1 ? rest : rest.slice(0, nextExport);
      expect(fnBody, `${name}: must gate on the export permission`).toMatch(
        /permission:\s*'(contacts|deals)\.export'/,
      );
      expect(fnBody, `${name}: must audit every export`).toMatch(/\bwriteAuditEntry\s*\(/);
      expect(fnBody, `${name}: must throttle exports`).toMatch(/\bcheckIpRateLimit\s*\(/);
    }
  });
});

describe('CRM validation boundary', () => {
  it('deal stages are exactly the six CHECK values', () => {
    expect([...DEAL_STAGES]).toEqual([
      'NEW',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(DealStageSchema.safeParse('CLOSED').success).toBe(false);
    expect(DealStageSchema.safeParse('WON').success).toBe(true);
  });

  it('company names cannot be blank; updates need at least one field', () => {
    expect(CreateCompanySchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(CreateCompanySchema.safeParse({ name: 'Acme' }).success).toBe(true);
    expect(UpdateCompanySchema.safeParse({}).success).toBe(false);
    expect(UpdateCompanySchema.safeParse({ phone: '+91 80 1234 5678' }).success).toBe(true);
  });

  it('contact and deal creates reject malformed input', () => {
    expect(CreateContactSchema.safeParse({ firstName: '', lastName: 'X' }).success).toBe(false);
    expect(
      CreateContactSchema.safeParse({ firstName: 'A', lastName: 'B', email: 'nope' }).success,
    ).toBe(false);
    expect(CreateDealSchema.safeParse({ title: 'T', probability: 101 }).success).toBe(false);
    expect(CreateDealSchema.safeParse({ title: 'T', value: '-5' }).success).toBe(false);
    expect(
      CreateDealSchema.safeParse({ title: 'T', expectedCloseDate: '30-09-2026' }).success,
    ).toBe(false);
  });

  it('list pagination defaults to 25 and caps at 100', () => {
    expect(ListQuerySchema.parse({}).limit).toBe(25);
    expect(ListQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(ListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('deal listing accepts an optional validated stage filter', () => {
    expect(ListDealsQuerySchema.parse({ stage: 'WON' }).stage).toBe('WON');
    expect(ListDealsQuerySchema.parse({}).stage).toBeUndefined();
    expect(ListDealsQuerySchema.safeParse({ stage: 'CLOSED' }).success).toBe(false);
  });
});
