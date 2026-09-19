import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db/authorized';

/**
 * Target visibility probes — step 5 of blueprint 7.4, answered by the database.
 *
 * A probe asks one question inside the caller's own authorized transaction: can this identity
 * see this record? It is a plain `select exists (...)` against the record's table, so the answer
 * is whatever that table's RLS policy says — scope, tenant, soft delete and, where the policy
 * consults them, record grants. Nothing here evaluates a scope, a membership or a grant, which
 * is what keeps this from becoming a second authorization model.
 *
 * ── WHAT THE PHASE 1 PROBES ANSWER TODAY ─────────────────────────────────────────
 *
 * Since Task 1.16, people and engagements carry the database.md 4.2 template: a probe answers
 * true for the caller's own record, for a GLOBAL holder, for the live department of a DEPARTMENT
 * holder, and for the manager chain of a TEAM holder. PROJECT stays false until Phase 4 brings
 * authz.is_project_member(), so a person whose effective scope is PROJECT reaches nothing here —
 * the fail-closed direction. Which permission key gates which table is the policy's business,
 * not this file's: a probe only asks whether the row is visible.
 *
 * ── THE REGISTRY IS CLOSED ───────────────────────────────────────────────────────
 *
 * There is no runtime registration. A probe that returned true without asking the database would
 * silently remove step 5 for its entity, so adding one is a reviewed change to this file
 * (src/lib/authz is CODEOWNERS-protected), never a call someone can make from elsewhere.
 */

export type TargetEntity = 'person' | 'engagement';

type Probe = (tx: Tx, id: string) => Promise<boolean>;

const PROBES: Readonly<Record<TargetEntity, Probe>> = Object.freeze({
  person: async (tx, id) =>
    (
      await tx.execute<{ visible: boolean }>(
        sql`select exists (select 1 from public.people p where p.id = ${id}::uuid) as visible`,
      )
    ).rows[0]?.visible === true,

  engagement: async (tx, id) =>
    (
      await tx.execute<{ visible: boolean }>(
        sql`select exists (select 1 from public.engagements e where e.id = ${id}::uuid) as visible`,
      )
    ).rows[0]?.visible === true,
});

export function isTargetEntity(value: unknown): value is TargetEntity {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROBES, value);
}

/**
 * Is this record visible to the identity carried by `tx`? The id must already be a validated
 * uuid. RLS decides; this function only asks.
 */
export function probeTarget(entity: TargetEntity, tx: Tx, id: string): Promise<boolean> {
  return PROBES[entity](tx, id);
}
