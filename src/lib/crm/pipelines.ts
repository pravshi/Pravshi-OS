import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { softDeleteRow } from './soft-delete';
import { writeAuditEntry } from '@/lib/audit/log';
import {
  CreatePipelineSchema,
  CreatePipelineStageSchema,
  DEAL_STAGES,
  ListPipelinesQuerySchema,
  MoveDealToStageSchema,
  UpdatePipelineSchema,
  UpdatePipelineStageSchema,
  type DealStage,
  type Forecast,
  type ForecastStageRow,
  type ListPipelinesQuery,
  type MoveDealResult,
  type Page,
  type Pipeline,
  type PipelineListRow,
  type PipelineStage,
  type PipelineWithStages,
  type Velocity,
  type VelocityStageRow,
} from './schema';

/**
 * Pipeline service (Phase 3). Same trust boundaries as the CRM core services:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller
 *  - pipelines and stages are org-level configuration: no owner_person_id,
 *    no created_by/updated_by writes (the triggers own those)
 *  - pipeline deletion is soft only, via softDeleteRow() → the SECURITY
 *    DEFINER public.crm_soft_delete('pipeline', …) (migration 0037)
 *  - stages have NO runtime delete path at all: migration 0037 revokes DELETE
 *    on pipeline_stages from the runtime roles and installs no DELETE policy.
 *    deleteStage() therefore refuses with INVALID_REQUEST (documented below);
 *    only app_owner may hard-delete a stage, and the deals FK blocks
 *    referenced stages there too.
 *  - an UPDATE or soft-delete that touches zero rows is a NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 *  - deals.pipeline_id is immutable: the service never writes it (the DB
 *    trigger raises 42501); the only pipeline_id writer is deal creation
 *  - the service never writes deal_stage_history rows: the
 *    deals_record_stage_history() trigger stamps them (changed_by from the
 *    session identity). Whenever the service sets pipeline_stage_id it also
 *    dual-writes the legacy deals.stage text (via legacyStageFor — the 0033
 *    CHECK admits only the six legacy values, so custom stage names map
 *    through the terminal flags) so deals_stamp_closed_at and pre-Phase-4
 *    code keep working.
 *
 * ── THE STAGE-MEMBERSHIP READ (moveDealToStage) ─────────────────────────────
 *
 * Only SUPER_ADMIN/ADMIN hold the pipeline keys, so a SALES caller moving a
 * deal cannot SELECT pipeline_stages rows (RLS denies: no pipelines.view).
 * The membership question — "does this stage belong to the deal's pipeline?"
 * — is therefore answered via public.crm_resolve_pipeline_stage() (migration
 * 0038), a SECURITY DEFINER, STABLE function that bypasses the stage RLS
 * while enforcing org isolation (authz.org_id()) and pipeline liveness
 * (pipelines.deleted_at IS NULL) inside the function body.
 *
 *   SELECT r.pipeline_id, r.stage_name, r.is_won, r.is_lost
 *   FROM public.crm_resolve_pipeline_stage($1) r
 *
 * A zero-row answer is indistinguishable by design (nonexistent, cross-org,
 * or on a deleted pipeline) and fails closed with INVALID_REQUEST. Stage
 * rows are never returned to callers who may not read them; the move
 * endpoint answers only { ok, dealId, fromStageId, toStageId }.
 */

const PIPELINE_COLUMNS = sql`
  p.id,
  p.name,
  p.description,
  p.is_default as "isDefault",
  p.created_at as "createdAt",
  p.updated_at as "updatedAt"
`;

const STAGE_COLUMNS = sql`
  s.id,
  s.pipeline_id as "pipelineId",
  s.name,
  s.position,
  s.probability::text as probability,
  s.color,
  s.is_won as "isWon",
  s.is_lost as "isLost",
  s.created_at as "createdAt"
`;

const PIPELINE_WHERE = (auth: Authorization) => sql`
  p.org_id = ${auth.ctx.orgId}::uuid
  and p.deleted_at is null
`;

/** True when the error is a Postgres error with the given SQLSTATE. */
function isPgCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const LEGACY_STAGE_SET: ReadonlySet<string> = new Set(DEAL_STAGES);

/**
 * Legacy dual-write mapping. deals.stage still carries the CHECK
 * stage IN ('NEW','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST') (0033,
 * untouched by 0037), so a custom stage name cannot be written verbatim —
 * the brief's "write the stage name" would raise 23514. The mapping
 * preserves exactly what the legacy column still drives:
 * deals_stamp_closed_at() only distinguishes WON/LOST from the rest.
 * Terminal flags are authoritative; a legacy name passes through unchanged
 * (the default pipeline's names are the legacy six, so old code sees
 * identical values); any other open stage maps to the generic open bucket.
 */
function legacyStageFor(name: string, isWon: boolean, isLost: boolean): DealStage {
  if (isWon) return 'WON';
  if (isLost) return 'LOST';
  return (LEGACY_STAGE_SET.has(name) ? name : 'NEW') as DealStage;
}

/** The named pipeline must be live and visible in the caller's org. */
async function assertPipelineVisible(
  tx: Tx,
  auth: Authorization,
  pipelineId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.pipelines p
    where p.id = ${pipelineId}::uuid
      and ${PIPELINE_WHERE(auth)}
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE — the leading constant keeps the btree index on name usable.
  return sql` and p.name ilike ${search} || '%'`;
}

export async function listPipelines(
  auth: Authorization,
  input: unknown,
): Promise<Page<PipelineListRow>> {
  const query: ListPipelinesQuery = ListPipelinesQuerySchema.parse(input);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<PipelineListRow>(sql`
        select ${PIPELINE_COLUMNS},
          (select count(*)::int
             from public.pipeline_stages s
            where s.pipeline_id = p.id) as "stageCount"
        from public.pipelines p
        where ${PIPELINE_WHERE(auth)} ${searchWhere(query.search)}
        order by p.is_default desc, p.name asc, p.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.pipelines p
        where ${PIPELINE_WHERE(auth)} ${searchWhere(query.search)}
      `),
    ]);
    return {
      rows: rows.rows,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

export async function createPipeline(
  auth: Authorization,
  input: unknown,
): Promise<PipelineWithStages> {
  const data = CreatePipelineSchema.parse(input);
  let id: string;
  try {
    id = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        insert into public.pipelines (org_id, name, description, is_default)
        values (
          ${auth.ctx.orgId}::uuid,
          ${data.name},
          ${data.description ?? null},
          ${data.isDefault}
        )
        returning id
      `);
      const row = res.rows[0];
      if (!row) throw new Error('Pipeline creation failed.');
      return row.id;
    });
  } catch (error) {
    // The partial unique index allows exactly one live default per org.
    if (isPgCode(error, '23505')) {
      throw new Error('INVALID_REQUEST: a default pipeline already exists');
    }
    throw error;
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'pipeline.created',
      entityType: 'pipeline',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { name: data.name, isDefault: data.isDefault },
    },
    auth.meta,
  );
  return getPipeline(auth, id);
}

export async function getPipeline(auth: Authorization, id: string): Promise<PipelineWithStages> {
  const pipeline = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Pipeline>(sql`
      select ${PIPELINE_COLUMNS}
      from public.pipelines p
      where ${PIPELINE_WHERE(auth)}
        and p.id = ${id}::uuid
    `);
    const row = res.rows[0] ?? null;
    await assertTargetAffected(auth, row ? 1 : 0);
    const stages = await tx.execute<PipelineStage>(sql`
      select ${STAGE_COLUMNS}
      from public.pipeline_stages s
      where s.pipeline_id = ${id}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
      order by s.position asc, s.id asc
    `);
    return { ...(row as Pipeline), stages: stages.rows };
  });
  return pipeline;
}

export async function updatePipeline(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<PipelineWithStages> {
  const data = UpdatePipelineSchema.parse(input);
  try {
    await withAuthorizedDb(auth.ctx, async (tx) => {
      if (data.isDefault === true) {
        // Promoting a second live default would violate the partial unique
        // index; fail closed with a 400 here instead of a 500 from the DB.
        const other = await tx.execute(sql`
          select 1
          from public.pipelines p
          where p.org_id = ${auth.ctx.orgId}::uuid
            and p.is_default
            and p.deleted_at is null
            and p.id <> ${id}::uuid
          limit 1
        `);
        if ((other.rowCount ?? 0) > 0) {
          throw new Error('INVALID_REQUEST: a default pipeline already exists');
        }
      }
      const sets: SQL[] = [];
      if (data.name !== undefined) sets.push(sql`name = ${data.name}`);
      if (data.description !== undefined) sets.push(sql`description = ${data.description}`);
      if (data.isDefault !== undefined) sets.push(sql`is_default = ${data.isDefault}`);
      const res = await tx.execute(sql`
        update public.pipelines p
        set ${sql.join(sets, sql`, `)}, updated_at = now()
        where p.id = ${id}::uuid
          and ${PIPELINE_WHERE(auth)}
        returning p.id
      `);
      await assertTargetAffected(auth, res.rowCount ?? 0);
    });
  } catch (error) {
    // Race backstop for the pre-check above: the index is the authority.
    if (isPgCode(error, '23505')) {
      throw new Error('INVALID_REQUEST: a default pipeline already exists');
    }
    throw error;
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'pipeline.updated',
      entityType: 'pipeline',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return getPipeline(auth, id);
}

/** Soft delete only: sets deleted_at via crm_soft_delete(). Refuses when live deals reference the pipeline. */
export async function deletePipeline(auth: Authorization, id: string): Promise<void> {
  const inUse = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute(sql`
      select 1
      from public.deals d
      where d.pipeline_id = ${id}::uuid
        and d.org_id = ${auth.ctx.orgId}::uuid
        and d.deleted_at is null
      limit 1
    `);
    return (res.rowCount ?? 0) > 0;
  });
  if (inUse) {
    throw new Error('INVALID_REQUEST: the pipeline has live deals and cannot be deleted');
  }
  await softDeleteRow(
    auth,
    'pipeline',
    sql`public.pipelines p`,
    sql`p.id = ${id}::uuid and ${PIPELINE_WHERE(auth)}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'pipeline.deleted',
      entityType: 'pipeline',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}

export async function listStages(
  auth: Authorization,
  pipelineId: string,
): Promise<PipelineStage[]> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertPipelineVisible(tx, auth, pipelineId);
    const res = await tx.execute<PipelineStage>(sql`
      select ${STAGE_COLUMNS}
      from public.pipeline_stages s
      where s.pipeline_id = ${pipelineId}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
      order by s.position asc, s.id asc
    `);
    return res.rows;
  });
}

export async function createStage(
  auth: Authorization,
  pipelineId: string,
  input: unknown,
): Promise<PipelineStage> {
  // The pipeline id is authoritative from the path; it is merged here so the
  // schema's pipelineId requirement is satisfied server-side, never from the
  // caller's body alone.
  const data = CreatePipelineStageSchema.parse({ ...asRecord(input), pipelineId });
  const stage = await withAuthorizedDb(auth.ctx, async (tx) => {
    await assertPipelineVisible(tx, auth, pipelineId);
    let position = data.position;
    if (position === undefined) {
      const maxRes = await tx.execute<{ max: number | null }>(sql`
        select max(s.position)::int as max
        from public.pipeline_stages s
        where s.pipeline_id = ${pipelineId}::uuid
          and s.org_id = ${auth.ctx.orgId}::uuid
      `);
      position = (maxRes.rows[0]?.max ?? -1) + 1;
    }
    try {
      const res = await tx.execute<PipelineStage>(sql`
        insert into public.pipeline_stages
          (org_id, pipeline_id, name, position, probability, color, is_won, is_lost)
        values (
          ${auth.ctx.orgId}::uuid,
          ${pipelineId}::uuid,
          ${data.name},
          ${position},
          ${data.probability},
          ${data.color ?? null},
          ${data.isWon},
          ${data.isLost}
        )
        returning id,
          pipeline_id as "pipelineId",
          name,
          position,
          probability::text as probability,
          color,
          is_won as "isWon",
          is_lost as "isLost",
          created_at as "createdAt"
      `);
      const row = res.rows[0];
      if (!row) throw new Error('Stage creation failed.');
      return row;
    } catch (error) {
      // UNIQUE (pipeline_id, position): an explicit position that is taken.
      if (isPgCode(error, '23505')) {
        throw new Error('INVALID_REQUEST: position is already taken in this pipeline');
      }
      throw error;
    }
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'pipeline_stage.created',
      entityType: 'pipeline_stage',
      entityId: stage.id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { pipelineId, name: data.name },
    },
    auth.meta,
  );
  return stage;
}

export async function updateStage(
  auth: Authorization,
  stageId: string,
  input: unknown,
): Promise<PipelineStage> {
  const data = UpdatePipelineStageSchema.parse(input);
  const stage = await withAuthorizedDb(auth.ctx, async (tx) => {
    const probe = await tx.execute<{
      pipeline_id: string;
      is_won: boolean;
      is_lost: boolean;
    }>(sql`
      select s.pipeline_id, s.is_won, s.is_lost
      from public.pipeline_stages s
      where s.id = ${stageId}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
    `);
    const current = probe.rows[0] ?? null;
    await assertTargetAffected(auth, current ? 1 : 0);
    const pipeline_id = (current as { pipeline_id: string }).pipeline_id;

    // Terminal coherence on the merged row (the DB CHECK is the backstop).
    const isWon = data.isWon ?? (current as { is_won: boolean }).is_won;
    const isLost = data.isLost ?? (current as { is_lost: boolean }).is_lost;
    if (isWon && isLost) {
      throw new Error('INVALID_REQUEST: a stage cannot be both won and lost');
    }

    if (data.position !== undefined) {
      // Reorder: lock the sibling rows, splice the target into its new slot,
      // then renumber densely. The two-phase renumber (via negatives) never
      // transiently violates UNIQUE (pipeline_id, position).
      const sibs = await tx.execute<{ id: string }>(sql`
        select s.id
        from public.pipeline_stages s
        where s.pipeline_id = ${pipeline_id}::uuid
          and s.org_id = ${auth.ctx.orgId}::uuid
        order by s.position asc, s.id asc
        for update
      `);
      const ids = sibs.rows.map((r) => r.id).filter((sid) => sid !== stageId);
      const at = Math.min(Math.max(data.position, 0), ids.length);
      ids.splice(at, 0, stageId);
      await tx.execute(sql`
        update public.pipeline_stages s
        set position = -s.position - 1
        where s.pipeline_id = ${pipeline_id}::uuid
          and s.org_id = ${auth.ctx.orgId}::uuid
      `);
      for (let i = 0; i < ids.length; i++) {
        await tx.execute(sql`
          update public.pipeline_stages s
          set position = ${i}
          where s.id = ${ids[i]}::uuid
            and s.org_id = ${auth.ctx.orgId}::uuid
        `);
      }
    }

    const sets: SQL[] = [];
    if (data.name !== undefined) sets.push(sql`name = ${data.name}`);
    if (data.probability !== undefined) sets.push(sql`probability = ${data.probability}`);
    if (data.color !== undefined) sets.push(sql`color = ${data.color}`);
    if (data.isWon !== undefined) sets.push(sql`is_won = ${data.isWon}`);
    if (data.isLost !== undefined) sets.push(sql`is_lost = ${data.isLost}`);
    if (sets.length > 0) {
      await tx.execute(sql`
        update public.pipeline_stages s
        set ${sql.join(sets, sql`, `)}
        where s.id = ${stageId}::uuid
          and s.org_id = ${auth.ctx.orgId}::uuid
      `);
    }

    const row = await tx.execute<PipelineStage>(sql`
      select ${STAGE_COLUMNS}
      from public.pipeline_stages s
      where s.id = ${stageId}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
    `);
    const updated = row.rows[0];
    if (!updated) throw new Error('Stage update failed.');
    return updated;
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'pipeline_stage.updated',
      entityType: 'pipeline_stage',
      entityId: stageId,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  return stage;
}

/**
 * Stages are append-only at runtime: migration 0037 revokes DELETE on
 * pipeline_stages from the runtime roles and installs no DELETE policy, so
 * there is no privileged write path for the service to call. Refuses with
 * INVALID_REQUEST (after the 404 concealment probe and the in-use guard).
 * Only app_owner may hard-delete a stage, and then only when no deal
 * references it — the FK from deals blocks anything else.
 */
export async function deleteStage(auth: Authorization, stageId: string): Promise<void> {
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const probe = await tx.execute(sql`
      select 1
      from public.pipeline_stages s
      where s.id = ${stageId}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
    `);
    await assertTargetAffected(auth, probe.rowCount ?? 0);
    const used = await tx.execute(sql`
      select 1
      from public.deals d
      where d.pipeline_stage_id = ${stageId}::uuid
        and d.org_id = ${auth.ctx.orgId}::uuid
        and d.deleted_at is null
      limit 1
    `);
    if ((used.rowCount ?? 0) > 0) {
      throw new Error('INVALID_REQUEST: the stage is in use by live deals and cannot be deleted');
    }
    throw new Error(
      'INVALID_REQUEST: pipeline stages cannot be deleted; rename or reorder the stage instead',
    );
  });
}

/**
 * Move a deal to another stage of its own pipeline.
 *
 * Permission: deals.edit (route-level). The deal visibility probe runs under
 * RLS: an invisible deal is concealed as NOT_FOUND.
 *
 * The target stage is resolved server-side in the same transaction, AS THE
 * CALLER. Callers with pipelines.view get full membership validation (a
 * cross-pipeline stage is INVALID_REQUEST, never a silent move — the DB
 * cannot express stage.pipeline_id = deal.pipeline_id as a plain FK, so this
 * check is the enforcement point). Callers without pipelines.view cannot see
 * stage rows at all; an unresolvable stage fails closed with INVALID_REQUEST
 * rather than moving on an unvalidated id. See the module header for why no
 * owner-level bypass is used here.
 *
 * No-op when the deal is already in the target stage: no UPDATE, no history
 * row (the recorder trigger fires only on actual change anyway), no audit.
 * Otherwise the UPDATE dual-writes the legacy deals.stage text so
 * deals_stamp_closed_at keeps working, and the history trigger stamps
 * changed_by from the session identity.
 */
export async function moveDealToStage(
  auth: Authorization,
  dealId: string,
  input: unknown,
): Promise<MoveDealResult> {
  const data = MoveDealToStageSchema.parse(input);
  const to_stage_id = data.stageId;
  const result = await withAuthorizedDb(auth.ctx, async (tx) => {
    const dealRes = await tx.execute<{
      pipeline_id: string | null;
      pipeline_stage_id: string | null;
    }>(sql`
      select d.pipeline_id, d.pipeline_stage_id
      from public.deals d
      where d.id = ${dealId}::uuid
        and d.org_id = ${auth.ctx.orgId}::uuid
        and d.deleted_at is null
    `);
    const deal = dealRes.rows[0] ?? null;
    await assertTargetAffected(auth, deal ? 1 : 0);
    const dealRow = deal as { pipeline_id: string | null; pipeline_stage_id: string | null };
    const from_stage_id = dealRow.pipeline_stage_id;
    const deal_pipeline = dealRow.pipeline_id;

    if (from_stage_id === to_stage_id) {
      return { from_stage_id, to_stage_id, stage_name: null as string | null, noop: true };
    }
    if (deal_pipeline === null) {
      throw new Error('INVALID_REQUEST: the deal is not assigned to a pipeline');
    }

    // Membership + name resolution via the SECURITY DEFINER resolver
    // (migration 0038): it bypasses the pipeline_stages RLS that hides stage
    // rows from callers without pipelines.view, while enforcing org isolation
    // and pipeline liveness inside the function. Zero rows = nonexistent,
    // cross-org, or on a deleted pipeline — indistinguishable by design.
    const stageRes = await tx.execute<{
      pipeline_id: string;
      stage_name: string;
      is_won: boolean;
      is_lost: boolean;
    }>(sql`
      select r.pipeline_id, r.stage_name, r.is_won, r.is_lost
      from public.crm_resolve_pipeline_stage(${to_stage_id}::uuid) r
    `);
    const stage = stageRes.rows[0] ?? null;
    if (!stage) {
      // Nonexistent, cross-org, or on a deleted pipeline.
      // Indistinguishable by design; fail closed. Stage rows are never
      // exposed to callers who may not read them.
      throw new Error('INVALID_REQUEST: unknown pipeline stage');
    }
    if (stage.pipeline_id !== deal_pipeline) {
      // F2 (LOW, Phase 3 security review): unified with the "unknown stage"
      // message above. Distinguishing "live stage in your org, wrong
      // pipeline" from "nothing/cross-org" would form a minor existence
      // oracle if stage UUIDs ever leak through another surface.
      throw new Error('INVALID_REQUEST: unknown pipeline stage');
    }

    // Dual-write the legacy deals.stage text (mapped through legacyStageFor —
    // the CHECK admits only the six legacy values) so deals_stamp_closed_at
    // and pre-Phase-4 code keep working. The history trigger records the
    // movement with changed_by from the session identity.
    const legacy_stage = legacyStageFor(stage.stage_name, stage.is_won, stage.is_lost);
    const upd = await tx.execute(sql`
      update public.deals d
      set pipeline_stage_id = ${to_stage_id}::uuid,
          stage = ${legacy_stage},
          updated_at = now()
      where d.id = ${dealId}::uuid
        and d.org_id = ${auth.ctx.orgId}::uuid
        and d.deleted_at is null
      returning d.id
    `);
    await assertTargetAffected(auth, upd.rowCount ?? 0);
    return { from_stage_id, to_stage_id, stage_name: stage.stage_name, noop: false };
  });

  if (!result.noop) {
    await writeAuditEntry(
      auth.ctx,
      {
        action: 'deal.stage_moved',
        entityType: 'deal',
        entityId: dealId,
        result: 'SUCCESS',
        severity: 'LOW',
        // Stage movements are access-affecting; the actor is recorded
        // explicitly here alongside the trigger-stamped audit row.
        metadata: {
          fromStageId: result.from_stage_id,
          toStageId: result.to_stage_id,
          actorPersonId: auth.ctx.personId,
        },
      },
      auth.meta,
    );
  }
  return {
    ok: true,
    dealId,
    fromStageId: result.from_stage_id,
    toStageId: result.to_stage_id,
  };
}

/**
 * Per-stage forecast for a pipeline: deal count, total value, and weighted
 * value (value × stage probability / 100). Money arithmetic stays in SQL;
 * values are returned as numeric strings, like Deal.value.
 */
export async function getForecast(auth: Authorization, pipelineId: string): Promise<Forecast> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertPipelineVisible(tx, auth, pipelineId);
    const [stages, totals] = await Promise.all([
      tx.execute<ForecastStageRow>(sql`
        select ps.id as "stageId",
               ps.name as "stageName",
               ps.position,
               ps.probability::text as probability,
               count(d.id)::int as "dealCount",
               coalesce(sum(d.value), 0)::text as "totalValue",
               coalesce(sum(d.value * ps.probability / 100), 0)::text as "weightedValue"
        from public.pipeline_stages ps
        left join public.deals d
          on d.pipeline_stage_id = ps.id
         and d.org_id = ps.org_id
         and d.deleted_at is null
        where ps.pipeline_id = ${pipelineId}::uuid
          and ps.org_id = ${auth.ctx.orgId}::uuid
        group by ps.id, ps.name, ps.position, ps.probability
        order by ps.position asc, ps.id asc
      `),
      tx.execute<{ dealCount: number; totalValue: string; weightedValue: string }>(sql`
        select count(d.id)::int as "dealCount",
               coalesce(sum(d.value), 0)::text as "totalValue",
               coalesce(sum(d.value * ps.probability / 100), 0)::text as "weightedValue"
        from public.deals d
        join public.pipeline_stages ps on ps.id = d.pipeline_stage_id
        where d.pipeline_id = ${pipelineId}::uuid
          and d.org_id = ${auth.ctx.orgId}::uuid
          and d.deleted_at is null
      `),
    ]);
    return {
      stages: stages.rows,
      totals: totals.rows[0] ?? { dealCount: 0, totalValue: '0', weightedValue: '0' },
    };
  });
}

/**
 * Per-stage velocity for a pipeline from deal_stage_history: average days a
 * deal spends in each stage (exit minus entry, completed stays only), plus
 * entry/exit counts and conversions from the immediately preceding stage.
 * One query; nulls where there is no data.
 */
export async function getVelocity(auth: Authorization, pipelineId: string): Promise<Velocity> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await assertPipelineVisible(tx, auth, pipelineId);
    const res = await tx.execute<VelocityStageRow>(sql`
      with scoped_history as (
        select h.deal_id, h.from_stage_id, h.to_stage_id, h.changed_at
        from public.deal_stage_history h
        join public.deals d
          on d.id = h.deal_id
         and d.org_id = h.org_id
        where h.org_id = ${auth.ctx.orgId}::uuid
          and d.pipeline_id = ${pipelineId}::uuid
          and d.deleted_at is null
      ),
      stays as (
        -- Each entry paired with its next exit from the same stage; deals
        -- still sitting in a stage have no exit and are excluded from the
        -- average (censored), not counted as zero.
        select e.to_stage_id as stage_id,
               extract(epoch from (min(x.changed_at) - e.changed_at)) / 86400 as days_in_stage
        from scoped_history e
        left join scoped_history x
          on x.deal_id = e.deal_id
         and x.from_stage_id = e.to_stage_id
         and x.changed_at > e.changed_at
        group by e.deal_id, e.to_stage_id, e.changed_at
      ),
      per_stage as (
        select stage_id,
               avg(days_in_stage)::float8 as avg_days,
               count(*)::int as samples
        from stays
        where days_in_stage is not null
        group by stage_id
      ),
      entries as (
        select to_stage_id as stage_id, count(*)::int as n
        from scoped_history
        group by to_stage_id
      ),
      departures as (
        select from_stage_id as stage_id, count(*)::int as n
        from scoped_history
        where from_stage_id is not null
        group by from_stage_id
      ),
      conversions as (
        select h.to_stage_id as stage_id, count(*)::int as n
        from scoped_history h
        join public.pipeline_stages cur on cur.id = h.to_stage_id
        join public.pipeline_stages prev
          on prev.pipeline_id = cur.pipeline_id
         and prev.position = cur.position - 1
        where h.from_stage_id = prev.id
        group by h.to_stage_id
      )
      select ps.id as "stageId",
             ps.name as "stageName",
             ps.position,
             s.avg_days as "avgDays",
             s.samples as "sampleCount",
             coalesce(e.n, 0) as "entriesCount",
             coalesce(x.n, 0) as "exitsCount",
             coalesce(c.n, 0) as "convertedFromPrevious"
      from public.pipeline_stages ps
      left join per_stage s on s.stage_id = ps.id
      left join entries e on e.stage_id = ps.id
      left join departures x on x.stage_id = ps.id
      left join conversions c on c.stage_id = ps.id
      where ps.pipeline_id = ${pipelineId}::uuid
        and ps.org_id = ${auth.ctx.orgId}::uuid
      order by ps.position asc, ps.id asc
    `);
    return { stages: res.rows };
  });
}
