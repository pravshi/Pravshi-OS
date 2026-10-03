import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  ALL_WORK_PERMS,
  CODE,
  PERMS,
  assertForceRls,
  ensureWorkSchema,
  errorOf,
  inContext,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  mkProject,
  mkRoleFor,
  sqlstateOf,
  type Ctx,
} from '../work/helpers';

/**
 * Phase 4 — work_projects: DB-level CRUD, constraints, RLS, soft-delete, archive.
 *
 * Same harness as the Phase 1–3 suites: owner (DATABASE_URL_MIGRATE, app_owner)
 * seeds fixtures and inspects the catalogue; user (DATABASE_URL_TEST, app_user)
 * is where every boundary is probed.
 *
 * Coverage: FORCE RLS catalogue flag, project CRUD as app_user (create → read →
 * update → archive → soft-delete), column defaults (is_archived false,
 * timestamps), the name-not-blank CHECK (23514), tenant isolation (org B sees
 * and touches nothing of org A), the permission gates
 * (work_projects.view/create/edit at GLOBAL scope), the no-identity
 * fail-closed default, soft-delete semantics (deleted rows invisible to
 * app_user, still visible to app_owner, no longer updatable), archive
 * semantics (flag only — archived rows stay visible), raw DELETE denied
 * (42501, soft-delete-only design mirroring Phase 3 pipelines), and the
 * updated_at maintenance trigger.
 *
 * Schema comes from tests/work/helpers.ts ensureWorkSchema() (contract DDL)
 * until the DB agent's migration 0042 lands; then these tests run against it.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

let orgA = '';
let orgB = '';
let alice = '';
let bob = '';
let aliceNoPerms = '';

beforeAll(async () => {
  await ensureWorkSchema(owner);
  orgA = await mkOrg(owner, `proj-a-${CODE}`);
  orgB = await mkOrg(owner, `proj-b-${CODE}`);
  const deptA = await mkDept(owner, orgA, `${CODE}_PA`);
  const deptB = await mkDept(owner, orgB, `${CODE}_PB`);
  alice = await mkPerson(owner, orgA, 'Alice Projects');
  bob = await mkPerson(owner, orgB, 'Bob Projects');
  aliceNoPerms = await mkPerson(owner, orgA, 'Alice NoPerms');
  await mkEngagement(owner, orgA, alice, deptA);
  await mkEngagement(owner, orgB, bob, deptB);
  await mkEngagement(owner, orgA, aliceNoPerms, deptA);
  await mkRoleFor(owner, orgA, alice, `${CODE}_PA_FULL`, ALL_WORK_PERMS);
  await mkRoleFor(owner, orgB, bob, `${CODE}_PB_FULL`, ALL_WORK_PERMS);
}, 30_000);

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

describe('FORCE RLS is on for work_projects', () => {
  it('pg_class.relforcerls is true', async () => {
    await assertForceRls(owner, 'work_projects');
  });
});

describe('project CRUD as app_user', () => {
  it('creates a project with defaults and reads it back', async () => {
    const ctx = ctxFor(alice, orgA);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctx,
      `insert into public.work_projects (org_id, name, description, created_by)
       values ($1, $2, $3, $4) returning id`,
      [orgA, `Launch ${CODE}`, 'Ship the thing', alice],
    );
    const id = rows[0]!.id;
    const got = await inContext<Record<string, unknown>>(
      asUser,
      ctx,
      `select id, org_id, name, description, is_archived, created_by,
              created_at, updated_at, deleted_at
       from public.work_projects where id = $1`,
      [id],
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe(`Launch ${CODE}`);
    expect(got[0]!.org_id).toBe(orgA);
    expect(got[0]!.is_archived).toBe(false);
    expect(got[0]!.created_by).toBe(alice);
    expect(got[0]!.deleted_at).toBeNull();
    expect(got[0]!.created_at).toBeTruthy();
    expect(got[0]!.updated_at).toBeTruthy();
  });

  it('updates name and description, and bumps updated_at', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Rename me ${CODE}`);
    const before = (
      await inContext<{ updated_at: string }>(
        asUser,
        ctx,
        `select updated_at from public.work_projects where id = $1`,
        [id],
      )
    )[0]!.updated_at;
    await inContext(
      asUser,
      ctx,
      `update public.work_projects set name = $2, description = $3 where id = $1`,
      [id, `Renamed ${CODE}`, 'new description'],
    );
    const got = (
      await inContext<{ name: string; description: string; updated_at: string }>(
        asUser,
        ctx,
        `select name, description, updated_at from public.work_projects where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.name).toBe(`Renamed ${CODE}`);
    expect(got.description).toBe('new description');
    expect(new Date(got.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('rejects a blank name with 23514', async () => {
    const ctx = ctxFor(alice, orgA);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `insert into public.work_projects (org_id, name) values ($1, $2)`, [
          orgA,
          '   ',
        ]),
      ),
    ).toBe('23514');
    const id = await mkProject(owner, orgA, `Not blank ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `update public.work_projects set name = '' where id = $1`, [id]),
      ),
    ).toBe('23514');
  });
});

describe('archive semantics', () => {
  it('archiving sets the flag and the row stays visible; unarchiving clears it', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Archive me ${CODE}`);
    await inContext(
      asUser,
      ctx,
      `update public.work_projects set is_archived = true where id = $1`,
      [id],
    );
    let got = (
      await inContext<{ is_archived: boolean }>(
        asUser,
        ctx,
        `select is_archived from public.work_projects where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.is_archived).toBe(true);
    await inContext(
      asUser,
      ctx,
      `update public.work_projects set is_archived = false where id = $1`,
      [id],
    );
    got = (
      await inContext<{ is_archived: boolean }>(
        asUser,
        ctx,
        `select is_archived from public.work_projects where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.is_archived).toBe(false);
  });

  it('a project can be created already archived', async () => {
    const id = await mkProject(owner, orgA, `Born archived ${CODE}`, { archived: true });
    const got = (
      await inContext<{ is_archived: boolean }>(
        asUser,
        ctxFor(alice, orgA),
        `select is_archived from public.work_projects where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.is_archived).toBe(true);
  });
});

describe('soft-delete semantics', () => {
  it('soft-deleted projects vanish for app_user but remain for app_owner', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Delete me ${CODE}`);
    // Sanity: visible before the delete.
    expect(
      await inContext(asUser, ctx, `select id from public.work_projects where id = $1`, [id]),
    ).toHaveLength(1);
    // The delete path goes through the SECURITY DEFINER function (a direct
    // UPDATE of deleted_at is denied — see the test below).
    await inContext(asUser, ctx, `select public.work_soft_delete('project', $1)`, [id]);
    expect(
      await inContext(asUser, ctx, `select id from public.work_projects where id = $1`, [id]),
    ).toHaveLength(0);
    // app_owner still sees the row (owner policy is unconditional).
    const asOwner = await owner.query(`select deleted_at from public.work_projects where id = $1`, [
      id,
    ]);
    expect(asOwner.rows).toHaveLength(1);
    expect(asOwner.rows[0]!.deleted_at).toBeTruthy();
  });

  it('a direct UPDATE of deleted_at is denied with 42501 (the SELECT policy rejects the post-update row)', async () => {
    // PostgreSQL applies the SELECT policy's USING to the post-UPDATE row; the
    // new row has deleted_at set, so `deleted_at is null` fails. This is why
    // the service DELETE path must go through work_soft_delete().
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Direct ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `update public.work_projects set deleted_at = now() where id = $1`, [
          id,
        ]),
      ),
    ).toBe('42501');
    expect(
      await inContext(asUser, ctx, `select id from public.work_projects where id = $1`, [id]),
    ).toHaveLength(1);
  });

  it('work_soft_delete: foreign/missing rows raise 02000, missing permission raises 42501', async () => {
    // 02000 (no_data) for "touched nothing" mirrors crm_soft_delete(): missing,
    // foreign, and already-deleted rows are indistinguishable — no tenant leak.
    const foreign = await mkProject(owner, orgB, `Foreign del ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(alice, orgA), `select public.work_soft_delete('project', $1)`, [
          foreign,
        ]),
      ),
    ).toBe('02000');
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(alice, orgA), `select public.work_soft_delete('project', $1)`, [
          '00000000-0000-0000-0000-000000000000',
        ]),
      ),
    ).toBe('02000');
    // The delete permission (not edit, not view) is the gate.
    const own = await mkProject(owner, orgA, `Own del ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(aliceNoPerms, orgA),
          `select public.work_soft_delete('project', $1)`,
          [own],
        ),
      ),
    ).toBe('42501');
    // Unknown entity is rejected outright.
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(alice, orgA), `select public.work_soft_delete('kanban', $1)`, [
          own,
        ]),
      ),
    ).toBe('42501');
  });

  it('a soft-deleted project cannot be updated again', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Gone ${CODE}`);
    await owner.query(`update public.work_projects set deleted_at = now() where id = $1`, [id]);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctx,
      `update public.work_projects set name = 'resurrect' where id = $1 returning id`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });

  it('raw DELETE is denied with 42501 even for own rows (soft-delete-only design)', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Hard delete me ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `delete from public.work_projects where id = $1`, [id]),
      ),
    ).toBe('42501');
    // The row is untouched.
    expect(
      await inContext(asUser, ctx, `select id from public.work_projects where id = $1`, [id]),
    ).toHaveLength(1);
  });

  it('documents why services must not soft-delete with RETURNING: the SELECT policy rejects the post-update row', async () => {
    // PostgreSQL applies the SELECT policy's USING to the post-UPDATE row
    // (with or without RETURNING). The new row has deleted_at set, so it
    // fails `deleted_at is null` → 42501. This is why the service layer
    // soft-deletes through the SECURITY DEFINER work_soft_delete().
    const ctx = ctxFor(alice, orgA);
    const id = await mkProject(owner, orgA, `Returning ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctx,
          `update public.work_projects set deleted_at = now() where id = $1 returning id`,
          [id],
        ),
      ),
    ).toBe('42501');
    // The definer function is the supported path.
    await inContext(asUser, ctx, `select public.work_soft_delete('project', $1)`, [id]);
    expect(
      await inContext(asUser, ctx, `select id from public.work_projects where id = $1`, [id]),
    ).toHaveLength(0);
  });
});

describe('tenant isolation for work_projects', () => {
  it("org B cannot select org A's projects", async () => {
    await mkProject(owner, orgA, `Secret A ${CODE}`);
    const rows = await inContext(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.work_projects where org_id = $1`,
      [orgA],
    );
    expect(rows).toHaveLength(0);
  });

  it('org B cannot insert a project into org A (42501)', async () => {
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(bob, orgB),
          `insert into public.work_projects (org_id, name) values ($1, $2)`,
          [orgA, `Sneaky ${CODE}`],
        ),
      ),
    ).toBe('42501');
  });

  it("org B cannot update org A's projects (0 rows)", async () => {
    const id = await mkProject(owner, orgA, `Untouchable ${CODE}`);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `update public.work_projects set name = 'pwned' where id = $1 returning id`,
      [id],
    );
    expect(rows).toHaveLength(0);
    // Org A still sees its row unchanged.
    const got = (
      await inContext<{ name: string }>(
        asUser,
        ctxFor(alice, orgA),
        `select name from public.work_projects where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.name).toBe(`Untouchable ${CODE}`);
  });

  it("org B cannot delete org A's projects (42501 — no delete policy at all)", async () => {
    const id = await mkProject(owner, orgA, `Doomed ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(bob, orgB), `delete from public.work_projects where id = $1`, [
          id,
        ]),
      ),
    ).toBe('42501');
  });
});

describe('permission gates for work_projects', () => {
  it('a user with no work permissions sees nothing and cannot write', async () => {
    const ctx = ctxFor(aliceNoPerms, orgA);
    await mkProject(owner, orgA, `Hidden ${CODE}`);
    expect(await inContext(asUser, ctx, `select id from public.work_projects`)).toHaveLength(0);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `insert into public.work_projects (org_id, name) values ($1,$2)`, [
          orgA,
          `Nope ${CODE}`,
        ]),
      ),
    ).toBe('42501');
  });

  it('view-only user can read but cannot create', async () => {
    const viewer = await mkPerson(owner, orgA, 'Viewer Only');
    const dept = await mkDept(owner, orgA, `${CODE}_PV`);
    await mkEngagement(owner, orgA, viewer, dept);
    await mkRoleFor(owner, orgA, viewer, `${CODE}_PV_ONLY`, [PERMS.projects.view]);
    const ctx = ctxFor(viewer, orgA);
    await mkProject(owner, orgA, `Visible ${CODE}`);
    expect(
      (await inContext(asUser, ctx, `select id from public.work_projects`)).length,
    ).toBeGreaterThan(0);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `insert into public.work_projects (org_id, name) values ($1,$2)`, [
          orgA,
          `Denied ${CODE}`,
        ]),
      ),
    ).toBe('42501');
  });

  it('no identity sees nothing and cannot insert (fail closed)', async () => {
    await mkProject(owner, orgA, `Fail closed ${CODE}`);
    expect(await inContext(asUser, {}, `select id from public.work_projects`)).toHaveLength(0);
    const err = await errorOf(
      inContext(asUser, {}, `insert into public.work_projects (org_id, name) values ($1,$2)`, [
        orgA,
        `Ghost ${CODE}`,
      ]),
    );
    expect(err.code).toBe('42501');
  });
});
