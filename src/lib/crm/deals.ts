import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { softDeleteRow } from './soft-delete';
import { writeAuditEntry } from '@/lib/audit/log';
import { assertDealReferences } from './refs';
import { dispatchWorkflowEvent, buildDedupKey } from '@/lib/workflows/events';
import { emitIntegrationEvent } from '@/lib/integrations/fanout';
import {
  CreateDealSchema,
  ListDealsQuerySchema,
  UpdateDealSchema,
  type Deal,
  type DealStage,
  type ListDealsQuery,
  type Page,
  type UpdateDealInput,
} from './schema';

/**
 * Deal service. Same trust boundaries as companies.ts, plus stage handling:
 *
 *  - The stage must be one of the six DealStage values (zod enum); anything else is
 *    rejected before it reaches the database, ahead of the CHECK constraint.
 *  - closed_at follows the stage: entering WON/LOST stamps it (first entry wins, via
 *    coalesce — reopening and re-closing keeps the original close); leaving for an
 *    open stage clears it. closed_at is never accepted from the caller.
 *  - every deal is born into the org's default pipeline: createDeal() resolves
 *    the default pipeline and the initial stage (matching the legacy stage
 *    name) through the SECURITY DEFINER public.crm_default_pipeline_stage(),
 *    because callers holding only deals.create cannot SELECT pipeline_stages.
 *    pipeline_id is INSERT-only afterwards (the DB trigger is the backstop).
 *  - PATCHing the legacy `stage` dual-writes pipeline_stage_id (resolved in
 *    the deal's own pipeline), so the stage-history trigger fires and the
 *    Kanban/forecast stay consistent with the legacy column.
 */

const CLOSED_STAGES: ReadonlySet<DealStage> = new Set(['WON', 'LOST']);

const SELECT_COLUMNS = sql`
  d.id,
  d.title,
  d.company_id as "companyId",
  co.name as "companyName",
  d.contact_id as "contactId",
  (ct.first_name || ' ' || ct.last_name) as "contactName",
  d.value::text as value,
  d.currency,
  d.stage,
  d.pipeline_id as "pipelineId",
  d.pipeline_stage_id as "pipelineStageId",
  d.probability,
  d.owner_person_id as "ownerPersonId",
  d.expected_close_date::text as "expectedCloseDate",
  d.closed_at::text as "closedAt",
  d.created_at as "createdAt",
  d.updated_at as "updatedAt"
`;

const FROM = sql`
  from public.deals d
  left join public.companies co
    on co.id = d.company_id
   and co.org_id = d.org_id
   and co.deleted_at is null
  left join public.contacts ct
    on ct.id = d.contact_id
   and ct.org_id = d.org_id
   and ct.deleted_at is null
`;

const BASE_WHERE = (auth: Authorization) => sql`
  d.org_id = ${auth.ctx.orgId}::uuid
  and d.deleted_at is null
`;

function searchWhere(search: string | undefined) {
  if (!search) return sql``;
  // Prefix ILIKE on the title — the leading constant keeps the btree index usable.
  return sql` and d.title ilike ${search} || '%'`;
}

/** Optional stage filter for pipeline views. Validated against the enum. */
export async function listDeals(auth: Authorization, input: unknown): Promise<Page<Deal>> {
  const query: ListDealsQuery = ListDealsQuerySchema.parse(input);
  const stage = query.stage;
  const stageWhere = stage ? sql` and d.stage = ${stage}` : sql``;
  // U3: server-side related-record filters (replaces client-side filtering of a
  // capped list on detail pages).
  const companyWhere = query.companyId ? sql` and d.company_id = ${query.companyId}::uuid` : sql``;
  const contactWhere = query.contactId ? sql` and d.contact_id = ${query.contactId}::uuid` : sql``;
  const pipelineWhere = query.pipelineId
    ? sql` and d.pipeline_id = ${query.pipelineId}::uuid`
    : sql``;
  const relatedWhere = sql`${companyWhere} ${contactWhere} ${pipelineWhere}`;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<Deal>(sql`
        select ${SELECT_COLUMNS}
        ${FROM}
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${stageWhere} ${relatedWhere}
        order by d.updated_at desc, d.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.deals d
        where ${BASE_WHERE(auth)} ${searchWhere(query.search)} ${stageWhere} ${relatedWhere}
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

export async function getDeal(auth: Authorization, id: string): Promise<Deal> {
  const deal = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<Deal>(sql`
      select ${SELECT_COLUMNS}
      ${FROM}
      where ${BASE_WHERE(auth)}
        and d.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, deal ? 1 : 0);
  return deal as Deal;
}

export async function createDeal(auth: Authorization, input: unknown): Promise<Deal> {
  const data = CreateDealSchema.parse(input);
  const closed = CLOSED_STAGES.has(data.stage);
  const created = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: referenced company/contact must be visible in the caller's org, and a
    // contact must belong to the deal's company (composite FK in 0033).
    await assertDealReferences(tx, auth, data.companyId, data.contactId);
    // Phase 3 exit fix: every deal is born into the org's default pipeline.
    // The assignment runs through the SECURITY DEFINER
    // public.crm_default_pipeline_stage() because callers holding only
    // deals.create cannot SELECT pipeline_stages (no pipelines.view); org
    // isolation and pipeline liveness are enforced inside the function. The
    // initial stage matches the deal's legacy stage name, falling back to the
    // pipeline's first stage. The AFTER INSERT history trigger records the
    // creation row (from_stage_id NULL).
    const assigned = await tx.execute<{
      pipeline_id: string;
      stage_id: string;
      stage_name: string;
    }>(sql`
      select r.pipeline_id, r.stage_id, r.stage_name
      from public.crm_default_pipeline_stage(${data.stage}) r
    `);
    const target = assigned.rows[0] ?? null;
    if (!target) {
      throw new Error(
        'INVALID_REQUEST: this organization has no default pipeline; ' +
          'an administrator must create one before deals can be added',
      );
    }
    const res = await tx.execute<{ id: string }>(sql`
      insert into public.deals (
        org_id, owner_person_id,
        title, company_id, contact_id, value, currency, stage,
        pipeline_id, pipeline_stage_id,
        probability, expected_close_date, closed_at
      ) values (
        ${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid,
        ${data.title},
        ${data.companyId ?? null}::uuid,
        ${data.contactId ?? null}::uuid,
        ${data.value ?? null}::numeric,
        ${data.currency},
        ${data.stage},
        ${target.pipeline_id}::uuid,
        ${target.stage_id}::uuid,
        ${data.probability ?? null},
        ${data.expectedCloseDate ?? null}::date,
        ${closed ? sql`now()` : sql`null`}
      )
      returning id
    `);
    const row = res.rows[0];
    if (!row) throw new Error('Deal creation failed.');
    return { id: row.id, pipelineId: target.pipeline_id, stageName: target.stage_name };
  });
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.created',
      entityType: 'deal',
      entityId: created.id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: {
        title: data.title,
        stage: data.stage,
        pipelineId: created.pipelineId,
        pipelineStageName: created.stageName,
      },
    },
    auth.meta,
  );
  // Phase 5: post-commit workflow event. Awaited inline (D1); never throws (D3).
  const deal = await getDeal(auth, created.id);
  await dispatchWorkflowEvent(auth, {
    type: 'deal.created',
    entityType: 'deal',
    entityId: deal.id,
    dedupKey: buildDedupKey('deal', deal.id),
    payload: {
      dealId: deal.id,
      dealTitle: deal.title,
      dealValue: deal.value,
      stage: deal.stage,
      isWon: deal.stage === 'WON',
      isLost: deal.stage === 'LOST',
    },
  });
  return deal;
}

const UPDATE_COLUMNS: Record<Exclude<keyof UpdateDealInput, 'stage'>, string> = {
  title: 'title',
  companyId: 'company_id',
  contactId: 'contact_id',
  value: 'value',
  currency: 'currency',
  probability: 'probability',
  expectedCloseDate: 'expected_close_date',
};

/**
 * Resolve a legacy stage name to a stage id in the deal's own pipeline.
 * Returns null when the deal has no pipeline (the write stays legacy-only)
 * or the pipeline has no stages (there is nothing better to resolve to).
 * The resolver is SECURITY DEFINER: callers holding only deals.edit cannot
 * SELECT pipeline_stages, and it enforces org isolation internally.
 */
async function resolvePipelineStageForLegacyName(
  tx: Tx,
  auth: Authorization,
  dealId: string,
  stageName: DealStage,
): Promise<string | null> {
  const deal = await tx.execute<{ pipeline_id: string | null }>(sql`
    select d.pipeline_id
    from public.deals d
    where d.id = ${dealId}::uuid
      and ${BASE_WHERE(auth)}
  `);
  const pipelineId = deal.rows[0]?.pipeline_id ?? null;
  if (!pipelineId) return null;
  const resolved = await tx.execute<{ stage_id: string }>(sql`
    select r.stage_id
    from public.crm_resolve_pipeline_stage_by_name(${pipelineId}::uuid, ${stageName}) r
  `);
  return resolved.rows[0]?.stage_id ?? null;
}

export async function updateDeal(auth: Authorization, id: string, input: unknown): Promise<Deal> {
  const data = UpdateDealSchema.parse(input);
  const txResult = await withAuthorizedDb(auth.ctx, async (tx) => {
    // A1: probe the effective post-update references. Untouched references keep
    // their current values so the contact↔company pairing stays verifiable.
    let companyId: string | null | undefined = 'companyId' in data ? data.companyId : undefined;
    let contactId: string | null | undefined = 'contactId' in data ? data.contactId : undefined;
    if (companyId !== undefined || contactId !== undefined) {
      const cur = await tx.execute<{ company_id: string | null; contact_id: string | null }>(
        sql`
          select d.company_id, d.contact_id
          from public.deals d
          where d.id = ${id}::uuid
            and d.org_id = ${auth.ctx.orgId}::uuid
            and d.deleted_at is null
        `,
      );
      const row = cur.rows[0];
      if (companyId === undefined) companyId = row?.company_id ?? null;
      if (contactId === undefined) contactId = row?.contact_id ?? null;
      await assertDealReferences(tx, auth, companyId, contactId);
    }
    // Phase 5 (P1-1): capture the pre-update stage so a legacy `stage` write
    // can emit deal.stage_changed below. Read-only and in-tx; a caller
    // without deals.view sees zero rows and the emission is skipped
    // fail-closed (same posture as the history read in moveDealToStage).
    let prevStage: string | null = null;
    let prevPipelineStageId: string | null = null;
    if (data.stage !== undefined) {
      const prev = await tx.execute<{ stage: string; pipeline_stage_id: string | null }>(
        sql`
          select d.stage, d.pipeline_stage_id
          from public.deals d
          where d.id = ${id}::uuid
            and d.org_id = ${auth.ctx.orgId}::uuid
            and d.deleted_at is null
        `,
      );
      prevStage = prev.rows[0]?.stage ?? null;
      prevPipelineStageId = prev.rows[0]?.pipeline_stage_id ?? null;
    }
    // Phase 3 exit fix: a PATCH of the legacy `stage` dual-writes
    // pipeline_stage_id, resolved in the deal's own pipeline through the
    // SECURITY DEFINER public.crm_resolve_pipeline_stage_by_name() (callers
    // holding only deals.edit cannot SELECT pipeline_stages). The history
    // trigger fires on the pipeline_stage_id change, so the Kanban and the
    // forecast stay consistent with the legacy column — the two stage writers
    // no longer diverge. A deal with no pipeline keeps the legacy-only write.
    let stageTarget: string | null = null;
    if (data.stage !== undefined) {
      stageTarget = await resolvePipelineStageForLegacyName(tx, auth, id, data.stage);
    }
    const sets = Object.entries(data).map(([key, value]) => {
      if (key === 'stage') {
        const stage = value as DealStage;
        // Entering WON/LOST stamps closed_at (first entry wins); leaving clears it.
        // When the stage is untouched, closed_at is left alone.
        const pipelineSet =
          stageTarget === null ? sql`` : sql`, pipeline_stage_id = ${stageTarget}::uuid`;
        return sql`stage = ${stage}, closed_at = case
          when ${stage} in ('WON', 'LOST') then coalesce(closed_at, now())
          else null
        end${pipelineSet}`;
      }
      const column = UPDATE_COLUMNS[key as Exclude<keyof UpdateDealInput, 'stage'>];
      if (column === 'company_id' || column === 'contact_id')
        return sql`${sql.raw(column)} = ${value ?? null}::uuid`;
      if (column === 'value') return sql`${sql.raw(column)} = ${value ?? null}::numeric`;
      if (column === 'expected_close_date') return sql`${sql.raw(column)} = ${value ?? null}::date`;
      return sql`${sql.raw(column)} = ${value ?? null}`;
    });
    const res = await tx.execute(sql`
      update public.deals d
      set ${sql.join(sets, sql`, `)}, updated_at = now()
      where d.id = ${id}::uuid
        and ${BASE_WHERE(auth)}
      returning d.id
    `);
    // Phase 5 (P1-1): when the legacy stage actually changed, read the
    // history row the DB recorder trigger just wrote (in-tx, like
    // moveDealToStage) for a stable per-occurrence dedup key. Same-value
    // writes and RLS-invisible rows yield no history row → null.
    let historyId: string | null = null;
    const stageChanged = data.stage !== undefined && prevStage !== null && prevStage !== data.stage;
    if (stageChanged) {
      const historyRes = await tx.execute<{ id: string }>(sql`
        select h.id
        from public.deal_stage_history h
        where h.deal_id = ${id}::uuid
        order by h.changed_at desc
        limit 1
      `);
      historyId = historyRes.rows[0]?.id ?? null;
    }
    return {
      affected: res.rowCount ?? 0,
      stageChanged,
      historyId,
      prevPipelineStageId,
      stageTarget,
      nextStage: data.stage ?? null,
    };
  });
  await assertTargetAffected(auth, txResult.affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.updated',
      entityType: 'deal',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fields: Object.keys(data).join(',') },
    },
    auth.meta,
  );
  // Phase 5: post-commit workflow event. Awaited inline (D1); never throws (D3).
  // changedFields is trivially the parsed input's keys. The dedup key uses
  // the post-update updatedAt so each distinct update is its own occurrence
  // (a plain 'deal:<id>' key would suppress every update after the first).
  const deal = await getDeal(auth, id);
  await dispatchWorkflowEvent(auth, {
    type: 'deal.updated',
    entityType: 'deal',
    entityId: deal.id,
    dedupKey: buildDedupKey('deal_updated', deal.id, deal.updatedAt),
    payload: {
      dealId: deal.id,
      dealTitle: deal.title,
      dealValue: deal.value,
      stage: deal.stage,
      isWon: deal.stage === 'WON',
      isLost: deal.stage === 'LOST',
      changedFields: Object.keys(data),
    },
  });
  // Phase 5 (P1-1): a stage change via PATCH also emits deal.stage_changed
  // (the move endpoint is not the only stage writer). The from/to pipeline
  // stage names and won/lost flags resolve through the SECURITY DEFINER
  // public.crm_resolve_pipeline_stage() so callers without pipelines.view
  // still get a complete payload; on the legacy-only path (no pipeline) the
  // legacy stage name and enum derivation are the source of truth.
  if (txResult.stageChanged) {
    const toStageId = txResult.stageTarget;
    const fromStageId = txResult.prevPipelineStageId;
    const [fromStage, toStage] = await Promise.all([
      resolvePipelineStageNameFlags(auth, fromStageId),
      resolvePipelineStageNameFlags(auth, toStageId),
    ]);
    const nextStage = txResult.nextStage ?? deal.stage;
    await dispatchWorkflowEvent(auth, {
      type: 'deal.stage_changed',
      entityType: 'deal',
      entityId: deal.id,
      dedupKey:
        txResult.historyId !== null
          ? buildDedupKey('deal_stage_history', txResult.historyId)
          : buildDedupKey('deal_stage', deal.id, toStageId ?? nextStage, deal.updatedAt),
      payload: {
        dealId: deal.id,
        fromStageId,
        toStageId,
        fromStageName: fromStage.name,
        toStageName: toStage.name ?? nextStage,
        isWon: toStageId !== null ? toStage.isWon : nextStage === 'WON',
        isLost: toStageId !== null ? toStage.isLost : nextStage === 'LOST',
        dealTitle: deal.title,
        dealValue: deal.value,
      },
    });
    // Phase 10 (Wave W-out): outbound webhook fan-out for the close events
    // (deal.won / deal.lost). Same post-commit point and the same won/lost
    // flags as the dispatch above; the fan-out instance id reuses the
    // stage-change dedup basis, so a re-emission of this stage change
    // dedups in the queue. emitIntegrationEvent never throws.
    const stageIsWon = toStageId !== null ? toStage.isWon : nextStage === 'WON';
    const stageIsLost = toStageId !== null ? toStage.isLost : nextStage === 'LOST';
    if (stageIsWon || stageIsLost) {
      await emitIntegrationEvent(
        auth,
        stageIsWon ? 'deal.won' : 'deal.lost',
        {
          deal_id: deal.id,
          title: deal.title,
          value: deal.value,
          from_stage_id: fromStageId,
          to_stage_id: toStageId,
          from_stage_name: fromStage.name,
          to_stage_name: toStage.name ?? nextStage,
        },
        {
          eventInstanceId:
            txResult.historyId !== null
              ? buildDedupKey('deal_stage_history', txResult.historyId)
              : buildDedupKey('deal_stage', deal.id, toStageId ?? nextStage, deal.updatedAt),
        },
      );
    }
  }
  return deal;
}

/**
 * Resolves a pipeline stage id to its name + won/lost flags through the
 * SECURITY DEFINER public.crm_resolve_pipeline_stage() (org-isolated inside
 * the function; zero rows for nonexistent/cross-org stages). Used for the
 * deal.stage_changed payload on the PATCH path (P1-1/P1-2).
 */
async function resolvePipelineStageNameFlags(
  auth: Authorization,
  stageId: string | null,
): Promise<{ name: string | null; isWon: boolean; isLost: boolean }> {
  if (stageId === null) return { name: null, isWon: false, isLost: false };
  const res = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ stage_name: string; is_won: boolean; is_lost: boolean }>(sql`
      select r.stage_name, r.is_won, r.is_lost
      from public.crm_resolve_pipeline_stage(${stageId}::uuid) r
    `),
  );
  const row = res.rows[0];
  return row
    ? { name: row.stage_name, isWon: row.is_won, isLost: row.is_lost }
    : { name: null, isWon: false, isLost: false };
}

/** Soft delete only: sets deleted_at. There is no hard DELETE path. */
export async function deleteDeal(auth: Authorization, id: string): Promise<void> {
  await softDeleteRow(
    auth,
    'deal',
    sql`public.deals d`,
    sql`d.id = ${id}::uuid and ${BASE_WHERE(auth)}`,
  );
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'deal.deleted',
      entityType: 'deal',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}
