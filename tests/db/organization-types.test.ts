/**
 * Organization types and versioned templates (migration 0080).
 *
 * What is proven, against a live database (local or CI, never a protected target — see
 * tests/db-target-guard.ts on the guard branch):
 *   - the catalog and generic_crm v1 exist; Real Estate and Education are catalogued DISABLED;
 *   - existing organizations are generic_crm v1, and a new organization is born exactly as
 *     before 0080 (the six legacy stages);
 *   - an unknown, disabled or unpublished type/version is refused; a type never changes and a
 *     version never goes backwards;
 *   - a published template is immutable, cannot be deleted or truncated, and an invalid
 *     definition cannot be published;
 *   - pipelines seeded from one template are each organization's own rows (tenant scope);
 *   - upgrade_organization_template() is additive and is not executable by a runtime role;
 *   - app_user reads the catalog and nothing else: no write, no template access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { inContext, sqlstateOf } from '../helpers';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const LEGACY_STAGES = [
  'NEW/0/10.00/#6B7280/false/false',
  'QUALIFIED/1/25.00/#3B82F6/false/false',
  'PROPOSAL/2/50.00/#8B5CF6/false/false',
  'NEGOTIATION/3/75.00/#F59E0B/false/false',
  'WON/4/100.00/#10B981/true/false',
  'LOST/5/0.00/#EF4444/false/true',
];

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await owner.query(sql, params)).rows[0] as T;

const mkOrg = async (slug: string, extra = '', values: unknown[] = []) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug${extra ? `, ${extra}` : ''})
       values ($1, $2${values.map((_, i) => `, $${i + 3}`).join('')}) returning id`,
      [`OT ${slug}`, slug, ...values],
    )
  ).rows[0]!.id;

const stagesOf = async (orgId: string, pipelineName = 'Sales Pipeline') =>
  (
    await owner.query<{ s: string }>(
      `select s.name||'/'||s.position||'/'||s.probability||'/'||coalesce(s.color,'-')||'/'||s.is_won||'/'||s.is_lost as s
         from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
        where p.org_id = $1 and p.name = $2 and p.deleted_at is null order by s.position`,
      [orgId, pipelineName],
    )
  ).rows.map((r) => r.s);

const GENERIC_V1 = async () =>
  (
    await one<{ definition: Record<string, unknown> }>(
      `select definition from public.organization_type_templates
        where type_key = 'generic_crm' and version = 1`,
    )
  ).definition;

/** A distinct, valid v2 of a test-only type, so nothing here alters the shipped catalog. */
const TEST_TYPE = `t_${RUN}`;
const twoPipelines = (extraStage: string) => ({
  pipelines: [
    {
      name: 'Sales Pipeline',
      description: 'default',
      is_default: true,
      stages: [
        { name: 'OPEN', probability: 20, color: '#111111', is_won: false, is_lost: false },
        { name: 'WON', probability: 100, color: null, is_won: true, is_lost: false },
      ],
    },
    {
      name: 'Renewals',
      is_default: false,
      stages: [{ name: extraStage, probability: 50, is_won: false, is_lost: false }],
    },
  ],
});

describe.skipIf(!HAS_DB)('organization types (0080)', () => {
  beforeAll(async () => {
    await owner.query(
      `insert into public.organization_types (key, display_name, status) values ($1, 'Test type', 'ACTIVE')`,
      [TEST_TYPE],
    );
    await owner.query(
      `insert into public.organization_type_templates (type_key, version, status, definition, published_at)
       values ($1, 1, 'PUBLISHED', $2, now())`,
      [TEST_TYPE, JSON.stringify(twoPipelines('R1'))],
    );
  });

  afterAll(async () => {
    await owner.end();
    await asUser.end();
  });

  describe('catalog', () => {
    it('ships generic_crm ACTIVE with a published, valid v1; Real Estate and Education DISABLED', async () => {
      const rows = (
        await owner.query<{ key: string; status: string }>(
          `select key, status from public.organization_types
            where key in ('generic_crm','real_estate_crm','education_crm') order by key`,
        )
      ).rows;
      expect(rows).toEqual([
        { key: 'education_crm', status: 'DISABLED' },
        { key: 'generic_crm', status: 'ACTIVE' },
        { key: 'real_estate_crm', status: 'DISABLED' },
      ]);
      const v1 = await one<{ status: string; ok: boolean }>(
        `select status, public.organization_template_definition_valid(definition) as ok
           from public.organization_type_templates where type_key = 'generic_crm' and version = 1`,
      );
      expect(v1).toEqual({ status: 'PUBLISHED', ok: true });
      const disabledTemplates = await one<{ n: string }>(
        `select count(*) as n from public.organization_type_templates
          where type_key in ('real_estate_crm','education_crm')`,
      );
      expect(Number(disabledTemplates.n)).toBe(0);
    });

    it('generic_crm v1 is exactly the six legacy stages of the default pipeline', async () => {
      const def = (await GENERIC_V1()) as {
        pipelines: { name: string; is_default: boolean; stages: { name: string }[] }[];
      };
      expect(def.pipelines).toHaveLength(1);
      expect(def.pipelines[0]!.name).toBe('Sales Pipeline');
      expect(def.pipelines[0]!.is_default).toBe(true);
      expect(def.pipelines[0]!.stages.map((s) => s.name)).toEqual([
        'NEW',
        'QUALIFIED',
        'PROPOSAL',
        'NEGOTIATION',
        'WON',
        'LOST',
      ]);
    });
  });

  describe('organizations and backward compatibility', () => {
    it('an organization created without a type is generic_crm v1 and born with the legacy stages', async () => {
      const org = await mkOrg(`ot-default-${RUN}`);
      const row = await one<{ type_key: string; template_version: number }>(
        `select type_key, template_version from public.organizations where id = $1`,
        [org],
      );
      expect(row).toEqual({ type_key: 'generic_crm', template_version: 1 });
      expect(await stagesOf(org)).toEqual(LEGACY_STAGES);
    });

    it('every existing organization is on a published template', async () => {
      const bad = await one<{ n: string }>(
        `select count(*) as n from public.organizations o
          where not exists (select 1 from public.organization_type_templates t
                             where t.type_key = o.type_key and t.version = o.template_version
                               and t.status = 'PUBLISHED')`,
      );
      expect(Number(bad.n)).toBe(0);
    });

    it('an organization of a type is born with all of that template’s pipelines', async () => {
      const org = await mkOrg(`ot-typed-${RUN}`, 'type_key', [TEST_TYPE]);
      expect(await stagesOf(org)).toEqual([
        'OPEN/0/20.00/#111111/false/false',
        'WON/1/100.00/-/true/false',
      ]);
      expect(await stagesOf(org, 'Renewals')).toEqual(['R1/0/50.00/-/false/false']);
      const defaults = await one<{ n: string }>(
        `select count(*) as n from public.pipelines where org_id = $1 and is_default and deleted_at is null`,
        [org],
      );
      expect(Number(defaults.n)).toBe(1);
    });
  });

  describe('refusals', () => {
    it('an unknown type is refused (the type guard answers before the foreign key)', async () => {
      // BEFORE INSERT runs ahead of the foreign-key check, so the guard's 23514 is what answers;
      // the foreign key (organizations_type_fk) stays as the structural backstop.
      expect(await sqlstateOf(mkOrg(`ot-unknown-${RUN}`, 'type_key', ['no_such_type']))).toBe(
        '23514',
      );
    });

    it('a DISABLED type cannot be chosen', async () => {
      expect(await sqlstateOf(mkOrg(`ot-re-${RUN}`, 'type_key', ['real_estate_crm']))).toBe(
        '23514',
      );
      expect(await sqlstateOf(mkOrg(`ot-edu-${RUN}`, 'type_key', ['education_crm']))).toBe('23514');
    });

    it('a DRAFT template version cannot be chosen', async () => {
      await owner.query(
        `insert into public.organization_type_templates (type_key, version, status, definition)
         values ($1, 9, 'DRAFT', '{}'::jsonb)`,
        [TEST_TYPE],
      );
      expect(
        await sqlstateOf(mkOrg(`ot-draft-${RUN}`, 'type_key, template_version', [TEST_TYPE, 9])),
      ).toBe('23514');
    });

    it('an organization’s type never changes; its version never goes backwards', async () => {
      const org = await mkOrg(`ot-fixed-${RUN}`);
      expect(
        await sqlstateOf(
          owner.query(`update public.organizations set type_key = $1 where id = $2`, [
            TEST_TYPE,
            org,
          ]),
        ),
      ).toBe('23514');
      const typed = await mkOrg(`ot-back-${RUN}`, 'type_key', [TEST_TYPE]);
      expect(
        await sqlstateOf(
          owner.query(`update public.organizations set template_version = 0 where id = $1`, [
            typed,
          ]),
        ),
      ).toBe('23514');
    });

    it('a published template is immutable, undeletable and untruncatable', async () => {
      expect(
        await sqlstateOf(
          owner.query(
            `update public.organization_type_templates set definition = '{}'::jsonb
              where type_key = 'generic_crm' and version = 1`,
          ),
        ),
      ).toBe('23514');
      expect(
        await sqlstateOf(
          owner.query(
            `delete from public.organization_type_templates where type_key = 'generic_crm' and version = 1`,
          ),
        ),
      ).toBe('23514');
      // A plain TRUNCATE is refused outright (organizations references the table). TRUNCATE …
      // CASCADE is refused by the BEFORE TRUNCATE guard — but CASCADE first takes ACCESS
      // EXCLUSIVE on every table that references organizations, so on a shared test database it
      // deadlocks with concurrent suites (40P01, seen in the full run). The CASCADE refusal was
      // proven on an isolated database (23514); here the guard is pinned in the catalogue.
      expect(await sqlstateOf(owner.query(`truncate public.organization_type_templates`))).toBe(
        '0A000',
      );
      const guard = await one<{ n: string }>(
        `select count(*) as n from pg_trigger
          where tgrelid = 'public.organization_type_templates'::regclass
            and tgname = 'organization_type_templates_no_truncate' and tgenabled = 'O'`,
      );
      expect(Number(guard.n)).toBe(1);
      // Retiring is the one allowed move — proven on the test type's own v1 copy at v8.
      await owner.query(
        `insert into public.organization_type_templates (type_key, version, status, definition, published_at)
         values ($1, 8, 'PUBLISHED', $2, now())`,
        [TEST_TYPE, JSON.stringify(twoPipelines('R8'))],
      );
      expect(
        await sqlstateOf(
          owner.query(
            `update public.organization_type_templates set status = 'RETIRED' where type_key = $1 and version = 8`,
            [TEST_TYPE],
          ),
        ),
      ).toBe('NO ERROR');
      expect(
        await sqlstateOf(
          owner.query(
            `update public.organization_type_templates set status = 'PUBLISHED' where type_key = $1 and version = 8`,
            [TEST_TYPE],
          ),
        ),
      ).toBe('23514');
    });

    it.each([
      ['no pipelines', { pipelines: [] }],
      [
        'two defaults',
        {
          pipelines: [
            { name: 'A', is_default: true, stages: [{ name: 'X', probability: 1 }] },
            { name: 'B', is_default: true, stages: [{ name: 'Y', probability: 1 }] },
          ],
        },
      ],
      [
        'no default',
        { pipelines: [{ name: 'A', is_default: false, stages: [{ name: 'X', probability: 1 }] }] },
      ],
      ['a stage-less pipeline', { pipelines: [{ name: 'A', is_default: true, stages: [] }] }],
      [
        'probability above 100',
        { pipelines: [{ name: 'A', is_default: true, stages: [{ name: 'X', probability: 101 }] }] },
      ],
      [
        'a string probability',
        {
          pipelines: [
            { name: 'A', is_default: true, stages: [{ name: 'X', probability: 'high' }] },
          ],
        },
      ],
      [
        'a bad colour',
        {
          pipelines: [
            { name: 'A', is_default: true, stages: [{ name: 'X', probability: 1, color: 'red' }] },
          ],
        },
      ],
      [
        'won and lost',
        {
          pipelines: [
            {
              name: 'A',
              is_default: true,
              stages: [{ name: 'X', probability: 1, is_won: true, is_lost: true }],
            },
          ],
        },
      ],
      [
        'duplicate stage names',
        {
          pipelines: [
            {
              name: 'A',
              is_default: true,
              stages: [
                { name: 'X', probability: 1 },
                { name: 'X', probability: 2 },
              ],
            },
          ],
        },
      ],
      [
        'a blank stage name',
        { pipelines: [{ name: 'A', is_default: true, stages: [{ name: ' ', probability: 1 }] }] },
      ],
    ])('an invalid definition (%s) cannot be published', async (_label, definition) => {
      const version = 100 + Math.floor(Math.random() * 1_000_000);
      await owner.query(
        `insert into public.organization_type_templates (type_key, version, status, definition)
         values ($1, $2, 'DRAFT', $3)`,
        [TEST_TYPE, version, JSON.stringify(definition)],
      );
      expect(
        await sqlstateOf(
          owner.query(
            `update public.organization_type_templates set status = 'PUBLISHED', published_at = now()
              where type_key = $1 and version = $2`,
            [TEST_TYPE, version],
          ),
        ),
      ).toBe('23514');
    });
  });

  describe('tenant scope', () => {
    it('two organizations from one template get their own pipelines and stages', async () => {
      const a = await mkOrg(`ot-iso-a-${RUN}`, 'type_key', [TEST_TYPE]);
      const b = await mkOrg(`ot-iso-b-${RUN}`, 'type_key', [TEST_TYPE]);
      const rows = (
        await owner.query<{ org_id: string; pid: string; sid: string; sorg: string }>(
          `select p.org_id, p.id as pid, s.id as sid, s.org_id as sorg
             from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
            where p.org_id = any($1::uuid[])`,
          [[a, b]],
        )
      ).rows;
      expect(rows.every((r) => r.org_id === r.sorg)).toBe(true);
      const pidsA = new Set(rows.filter((r) => r.org_id === a).map((r) => r.pid));
      const pidsB = new Set(rows.filter((r) => r.org_id === b).map((r) => r.pid));
      expect(pidsA.size).toBe(2);
      expect(pidsB.size).toBe(2);
      expect([...pidsA].some((id) => pidsB.has(id))).toBe(false);
    });

    it('app_user in organization A sees none of organization B’s seeded pipelines', async () => {
      const a = await mkOrg(`ot-rls-a-${RUN}`, 'type_key', [TEST_TYPE]);
      const b = await mkOrg(`ot-rls-b-${RUN}`, 'type_key', [TEST_TYPE]);
      // No person or permission: the policy must still never return another org's rows.
      const visible = await inContext<{ org_id: string }>(
        asUser,
        { orgId: a },
        `select org_id from public.pipelines where org_id = $1`,
        [b],
      );
      expect(visible).toEqual([]);
    });
  });

  describe('upgrades', () => {
    it('moving to a newer published version is additive; existing data is untouched', async () => {
      const org = await mkOrg(`ot-up-${RUN}`, 'type_key', [TEST_TYPE]);
      const before = await stagesOf(org);
      await owner.query(
        `insert into public.organization_type_templates (type_key, version, status, definition, published_at)
         values ($1, 2, 'PUBLISHED', $2, now())`,
        [
          TEST_TYPE,
          JSON.stringify({
            pipelines: [
              ...twoPipelines('R2').pipelines,
              {
                name: 'Onboarding',
                is_default: false,
                stages: [{ name: 'KICKOFF', probability: 0 }],
              },
            ],
          }),
        ],
      );
      await owner.query(`select public.upgrade_organization_template($1, 2)`, [org]);
      const after = await one<{ template_version: number }>(
        `select template_version from public.organizations where id = $1`,
        [org],
      );
      expect(after.template_version).toBe(2);
      expect(await stagesOf(org)).toEqual(before); // default pipeline unchanged
      expect(await stagesOf(org, 'Renewals')).toEqual(['R1/0/50.00/-/false/false']); // kept, not replaced
      expect(await stagesOf(org, 'Onboarding')).toEqual(['KICKOFF/0/0.00/-/false/false']); // added
      expect(
        await sqlstateOf(owner.query(`select public.upgrade_organization_template($1, 2)`, [org])),
      ).toBe('23514');
    });

    it('no runtime role can execute the upgrade or the seeders', async () => {
      for (const role of ['app_user', 'app_admin', 'app_worker', 'app_auth']) {
        const r = await one<{ up: boolean; seed: boolean; tpl: boolean }>(
          `select has_function_privilege($1, 'public.upgrade_organization_template(uuid, integer)', 'EXECUTE') as up,
                  has_function_privilege($1, 'public.seed_default_pipeline(uuid)', 'EXECUTE') as seed,
                  has_function_privilege($1, 'public.seed_template_pipelines(uuid, jsonb)', 'EXECUTE') as tpl`,
          [role],
        );
        expect({ role, ...r }).toEqual({ role, up: false, seed: false, tpl: false });
      }
    });
  });

  describe('app_user access', () => {
    it('reads the catalog', async () => {
      const rows = await inContext<{ key: string }>(
        asUser,
        {},
        `select key from public.organization_types where key = 'generic_crm'`,
      );
      expect(rows).toEqual([{ key: 'generic_crm' }]);
    });

    it('cannot write the catalog or touch templates at all', async () => {
      expect(
        await sqlstateOf(
          inContext(
            asUser,
            {},
            `insert into public.organization_types (key, display_name) values ('evil_${RUN}', 'x')`,
          ),
        ),
      ).toBe('42501');
      expect(
        await sqlstateOf(
          inContext(asUser, {}, `update public.organization_types set status = 'ACTIVE'`),
        ),
      ).toBe('42501');
      expect(
        await sqlstateOf(inContext(asUser, {}, `select 1 from public.organization_type_templates`)),
      ).toBe('42501');
    });
  });
});
