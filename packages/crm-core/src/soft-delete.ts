import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';

/**
 * The allowlisted entity names accepted by public.crm_soft_delete().
 * Mirrors the CASE in migration 0034 (plus the 'pipeline' mapping added by
 * migration 0037) — the two lists must stay in lockstep.
 */
export type SoftDeleteEntity =
  | 'company'
  | 'contact'
  | 'deal'
  | 'activity'
  | 'company_contact'
  | 'company_link'
  | 'contact_link'
  | 'pipeline';

/**
 * Soft-delete exactly one CRM row as app_user.
 *
 * WHY TWO STEPS. PostgreSQL evaluates the SELECT policy's USING against the
 * POST-update row, so `UPDATE ... SET deleted_at = now()` fails with 42501
 * ("new row violates row-level security policy") even when the caller fully
 * satisfies the UPDATE policy — every CRM SELECT policy requires
 * `deleted_at is null`, which the new row violates. The write therefore goes
 * through the SECURITY DEFINER public.crm_soft_delete() (migration 0034),
 * which bypasses that check.
 *
 * Authorization is enforced, not bypassed:
 *  1. A no-op UPDATE runs as app_user under the table's real UPDATE policy
 *     (org, liveness, is_active, edit scope). It touches zero rows unless the
 *     caller may edit the target, and it takes a row lock.
 *  2. In the same transaction, crm_soft_delete() performs the write. Defense
 *     in depth inside the function: allowlisted entity only, the row must
 *     belong to the caller's org, and it must be live.
 *
 * A probe that touches zero rows is concealed as NOT_FOUND through
 * assertTargetAffected — the same concealment as an invisible target.
 *
 * @param target  UPDATE target, alias-qualified (e.g. sql`public.companies c`)
 * @param where   WHERE clause without the keyword, alias-qualified
 *                (e.g. sql`c.id = ${id}::uuid and ${BASE_WHERE(auth)}`)
 */
export async function softDeleteRow(
  auth: Authorization,
  entity: SoftDeleteEntity,
  target: SQL,
  where: SQL,
): Promise<void> {
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const probe = await tx.execute(sql`
      update ${target}
      set updated_at = updated_at
      where ${where}
      returning id
    `);
    const rowId = (probe.rows[0] as { id: string } | undefined)?.id;
    if (rowId) {
      await tx.execute(sql`select public.crm_soft_delete(${entity}, ${rowId}::uuid)`);
    }
    return probe.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
}
