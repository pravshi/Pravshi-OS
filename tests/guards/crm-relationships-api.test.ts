import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyseServerActions } from './require-permission-first.test';
import {
  COMPANY_LINK_TYPES,
  CompanyLinkTypeSchema,
  CONTACT_LINK_TYPES,
  ContactLinkTypeSchema,
  CreateCompanyContactSchema,
  CreateCompanyLinkSchema,
  CreateContactLinkSchema,
  ListQuerySchema,
  UpdateCompanyContactSchema,
} from '@/lib/crm/schema';

/**
 * Phase 2 Track B — relationships guards.
 *
 * Source-text heuristics mirroring tests/guards/crm-api.test.ts, for
 * src/lib/crm/relationships.ts and the relationships server actions:
 *
 *  1. the service takes an Authorization only requirePermission() can issue as its
 *     first parameter, and reaches Postgres only through withAuthorizedDb()
 *  2. the new server actions authorize first with the right relationships.* key
 *  3. no hard delete anywhere; soft delete is deleted_at = now() only, never cleared
 *  4. created_by/updated_by are never written — the trigger owns them
 *  5. owner_person_id/org_id never come from client input
 *  6. both endpoints of a relationship are probed for visibility before any write
 *     (A1 — the cross-org FK reference concealment)
 *  7. untrusted input is zod-validated before any query; limits are capped at 100
 */

const SERVICE_FILE = 'src/lib/crm/relationships.ts';
const ACTION_FILE = 'src/app/(app)/crm/actions.ts';

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (file: string) => readFileSync(file, 'utf8');

/** The source of one exported server action, cut out of the actions file. */
function actionBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}`);
  expect(start, `${name} not found in actions.ts`).toBeGreaterThan(-1);
  const rest = code.slice(code.indexOf('{', start));
  const nextExport = rest.search(/\nexport\s+async\s+function/);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe('relationships service reaches Postgres only through withAuthorizedDb()', () => {
  it('imports withAuthorizedDb and nothing that bypasses it', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/from '@\/lib\/db\/authorized'/);
    expect(code).not.toMatch(/from '@\/lib\/db\/pool'/);
    expect(code).not.toMatch(/from '@\/lib\/db\/auth-client'/);
    expect(code).not.toMatch(/pool\.connect\(/);
  });

  it('every exported function takes Authorization first', () => {
    const code = stripComments(read(SERVICE_FILE));
    const fns = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)];
    expect(fns.length).toBeGreaterThan(0);
    for (const [, name, params] of fns) {
      expect((params ?? '').trim(), name).toMatch(/^auth:\s*Authorization/);
    }
  });

  it('validates untrusted input with a zod schema before querying', () => {
    const code = stripComments(read(SERVICE_FILE));
    const fns = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)];
    for (const [, name, params] of fns) {
      if (!/\binput\b/.test(params ?? '')) continue;
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

  it('no hard DELETE, and deleted_at is set but never cleared', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/deleted_at\s*=\s*null/i);
    // Soft deletes go through softDeleteRow() (src/lib/crm/soft-delete.ts),
    // which enforces the UPDATE policy as app_user and then calls the
    // SECURITY DEFINER public.crm_soft_delete(). A plain
    // UPDATE ... SET deleted_at = now() fails 42501, so the service must not
    // set deleted_at directly; the clock is stamped inside crm_soft_delete().
    expect(code).toMatch(/\bsoftDeleteRow\s*\(/);
    expect(code).not.toMatch(/deleted_at\s*=\s*now\(\)/i);
  });

  it('never writes created_by/updated_by or client-supplied identity', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/created_by/);
    expect(code).not.toMatch(/updated_by/);
    expect(code).not.toMatch(/\bdata\.(orgId|ownerPersonId)\b/);
    expect(code).not.toMatch(/\binput\.(orgId|ownerPersonId)\b/);
    expect(code).toMatch(/auth\.ctx\.personId/);
    expect(code).toMatch(/auth\.ctx\.orgId/);
  });

  it('probes both endpoints of a relationship for visibility before any write (A1)', () => {
    const code = stripComments(read(SERVICE_FILE));
    // create/update/remove company-contact paths probe company AND contact
    expect(code).toMatch(/assertCompanyVisible\(tx, auth, data\.companyId\)/);
    expect(code).toMatch(/assertContactVisible\(tx, auth, data\.contactId\)/);
    expect(code).toMatch(/assertCompanyVisible\(tx, auth, companyId\)/);
    expect(code).toMatch(/assertContactVisible\(tx, auth, contactId\)/);
    // link writes probe both endpoints of the edge
    expect(code).toMatch(/assertCompanyVisible\(tx, auth, data\.fromCompanyId\)/);
    expect(code).toMatch(/assertCompanyVisible\(tx, auth, data\.toCompanyId\)/);
    expect(code).toMatch(/assertContactVisible\(tx, auth, data\.fromContactId\)/);
    expect(code).toMatch(/assertContactVisible\(tx, auth, data\.toContactId\)/);
    // list paths probe the anchor record first, so an invisible
    // company/contact fails closed with NOT_FOUND concealment
    const listProbe = (anchor: string, name: string) => {
      const start = code.indexOf(`function ${name}`);
      const head = code.slice(start, code.indexOf('{', start) + 4000);
      expect(head, `${name} probes ${anchor}`).toMatch(
        new RegExp(
          `await ${anchor}\\(tx, auth, ${anchor === 'assertCompanyVisible' ? 'companyId' : 'contactId'}\\)`,
        ),
      );
    };
    listProbe('assertCompanyVisible', 'listCompanyContacts');
    listProbe('assertCompanyVisible', 'listCompanyLinks');
    listProbe('assertContactVisible', 'listContactAssociations');
    listProbe('assertContactVisible', 'listContactLinks');
  });

  it('is_primary reassignment clears rival primary flags inside the same transaction', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/is_primary\s*=\s*false/);
  });

  it('documented: no REST routes for relationships (server actions only)', () => {
    // the no-REST decision lives in the service header comment, so read it unstripped
    expect(read(SERVICE_FILE)).toMatch(/NO REST routes for relationships/);
  });
});

describe('relationships entry points authorize first', () => {
  const ACTIONS = [
    'listCompanyContactsAction',
    'listContactAssociationsAction',
    'createCompanyContactAction',
    'updateCompanyContactAction',
    'removeCompanyContactAction',
    'listCompanyLinksAction',
    'createCompanyLinkAction',
    'removeCompanyLinkAction',
    'listContactLinksAction',
    'createContactLinkAction',
    'removeContactLinkAction',
  ] as const;

  it('every relationships server action awaits requirePermission() as its first statement', () => {
    expect(analyseServerActions(read(ACTION_FILE))).toEqual([]);
  });

  it.each([
    ['listCompanyContactsAction', 'relationships.view'],
    ['listContactAssociationsAction', 'relationships.view'],
    ['createCompanyContactAction', 'relationships.create'],
    ['updateCompanyContactAction', 'relationships.edit'],
    ['removeCompanyContactAction', 'relationships.delete'],
    ['listCompanyLinksAction', 'relationships.view'],
    ['createCompanyLinkAction', 'relationships.create'],
    ['removeCompanyLinkAction', 'relationships.delete'],
    ['listContactLinksAction', 'relationships.view'],
    ['createContactLinkAction', 'relationships.create'],
    ['removeContactLinkAction', 'relationships.delete'],
  ] as const)('%s gates on %s', (name, permission) => {
    const body = actionBody(stripComments(read(ACTION_FILE)), name);
    expect(body).toMatch(new RegExp(`permission:\\s*'${permission}'`));
    expect(ACTIONS).toContain(name);
  });

  it('relationship actions validate ids as UUIDs at the boundary (A3)', () => {
    const code = stripComments(read(ACTION_FILE));
    // every id argument the action takes is routed through the UUID schema
    const expected: Record<string, number> = {
      listCompanyContactsAction: 1,
      listContactAssociationsAction: 1,
      createCompanyContactAction: 0,
      updateCompanyContactAction: 2,
      removeCompanyContactAction: 2,
      listCompanyLinksAction: 1,
      createCompanyLinkAction: 0,
      removeCompanyLinkAction: 1,
      listContactLinksAction: 1,
      createContactLinkAction: 0,
      removeContactLinkAction: 1,
    };
    for (const [name, count] of Object.entries(expected)) {
      const body = actionBody(code, name);
      expect((body.match(/uuid\.parse\(/g) ?? []).length, name).toBe(count);
    }
  });

  it('no new action name collides with the export tripwire', () => {
    const code = stripComments(read(ACTION_FILE));
    for (const name of ACTIONS) {
      expect(name, name).not.toMatch(/export/i);
    }
  });
});

describe('relationships validation boundary', () => {
  it('link-type enums are exactly the CHECK values', () => {
    expect([...COMPANY_LINK_TYPES]).toEqual(['PARENT', 'SUBSIDIARY', 'PARTNER']);
    expect([...CONTACT_LINK_TYPES]).toEqual(['COLLEAGUE', 'REFERRAL', 'OTHER']);
    expect(CompanyLinkTypeSchema.safeParse('CHILD').success).toBe(false);
    expect(CompanyLinkTypeSchema.safeParse('PARTNER').success).toBe(true);
    expect(ContactLinkTypeSchema.safeParse('FRIEND').success).toBe(false);
    expect(ContactLinkTypeSchema.safeParse('REFERRAL').success).toBe(true);
  });

  it('company-contact creates need both endpoints; updates need at least one field', () => {
    const good = '123e4567-e89b-12d3-a456-426614174000';
    expect(CreateCompanyContactSchema.safeParse({ companyId: good, contactId: good }).success).toBe(
      true,
    );
    expect(
      CreateCompanyContactSchema.safeParse({ companyId: good, contactId: good, isPrimary: true })
        .success,
    ).toBe(true);
    expect(
      CreateCompanyContactSchema.parse({ companyId: good, contactId: good, isPrimary: true })
        .isPrimary,
    ).toBe(true);
    expect(CreateCompanyContactSchema.parse({ companyId: good, contactId: good }).isPrimary).toBe(
      false,
    );
    expect(
      CreateCompanyContactSchema.safeParse({ companyId: 'nope', contactId: good }).success,
    ).toBe(false);
    expect(
      CreateCompanyContactSchema.safeParse({
        companyId: good,
        contactId: good,
        role: 'x'.repeat(129),
      }).success,
    ).toBe(false);
    expect(UpdateCompanyContactSchema.safeParse({}).success).toBe(false);
    expect(UpdateCompanyContactSchema.safeParse({ role: 'Decision Maker' }).success).toBe(true);
    expect(UpdateCompanyContactSchema.safeParse({ isPrimary: true }).success).toBe(true);
  });

  it('link creates reject self-links and unknown types', () => {
    const good = '123e4567-e89b-12d3-a456-426614174000';
    const other = '123e4567-e89b-12d3-a456-426614174001';
    expect(
      CreateCompanyLinkSchema.safeParse({
        fromCompanyId: good,
        toCompanyId: good,
        linkType: 'PARENT',
      }).success,
    ).toBe(false);
    expect(
      CreateCompanyLinkSchema.safeParse({
        fromCompanyId: good,
        toCompanyId: other,
        linkType: 'PARENT',
      }).success,
    ).toBe(true);
    expect(
      CreateCompanyLinkSchema.safeParse({
        fromCompanyId: good,
        toCompanyId: other,
        linkType: 'CHILD',
      }).success,
    ).toBe(false);
    expect(
      CreateContactLinkSchema.safeParse({
        fromContactId: good,
        toContactId: good,
        linkType: 'COLLEAGUE',
      }).success,
    ).toBe(false);
    expect(
      CreateContactLinkSchema.safeParse({
        fromContactId: good,
        toContactId: other,
        linkType: 'REFERRAL',
      }).success,
    ).toBe(true);
  });

  it('list pagination defaults to 25 and caps at 100', () => {
    expect(ListQuerySchema.parse({}).limit).toBe(25);
    expect(ListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
