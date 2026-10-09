import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * Display gating for the AI summary panel (Phase 9, Workstream G; contract §9).
 *
 * The detail pages pass the returned boolean to <AiSummaryPanel canUseAi>.
 * This is UI rendering only, never an authorization decision: it reads
 * authz.has('ai.use') directly — the same pattern as lib/authz/nav.ts and
 * the CRM/work _permissions.ts held-set checks — so rendering a page never
 * audits a "denial". The assist route independently enforces `ai.use` via
 * withPermission(), and the orchestrator/context builder enforce every
 * record's own permission + RLS: hiding the panel grants nothing, and
 * showing it proves nothing.
 *
 * The pages' existing held-set helpers (getCrmPermissions/getWorkPermissions)
 * check fixed per-module key lists that predate Phase 9 and do not include
 * `ai.use`, so the panel's flag is computed here instead of widening those
 * lists from a mount edit.
 */
export async function canUseAi(): Promise<boolean> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ held: boolean }>(sql`
      select authz.has('ai.use') as held
    `);
    return res.rows[0]?.held ?? false;
  });
}
