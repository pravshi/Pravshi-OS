import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';

/**
 * Reference-visibility probes (A1 — cross-org foreign-key references).
 *
 * contacts.company_id and deals.company_id / deals.contact_id arrive as caller-supplied
 * UUIDs. Migration 0033 constrains them with composite, org-scoped foreign keys
 * ((company_id, org_id), (contact_id, org_id), and (contact_id, company_id, org_id)),
 * so a cross-tenant UUID can never create an association — but without a probe the
 * database answers with a 500 FK violation, and the 201-vs-500 difference is a
 * cross-tenant existence oracle.
 *
 * Every probe below runs inside the caller's own authorized transaction (RLS identity
 * already set) and re-states the org + liveness predicate explicitly. An invisible
 * reference — missing, deleted, or another tenant's — fails through assertTargetAffected,
 * i.e. the exact NOT_FOUND concealment the target-record checks use: the caller cannot
 * distinguish "nonexistent" from "another org's".
 *
 * The denial audit is written by refuse() on its own connection, so it survives the
 * rollback of the enclosing transaction.
 */

/** The referenced company must be live and visible in the caller's org. */
export async function assertCompanyVisible(
  tx: Tx,
  auth: Authorization,
  companyId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.companies c
    where c.id = ${companyId}::uuid
      and c.org_id = ${auth.ctx.orgId}::uuid
      and c.deleted_at is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/** The referenced contact must be live and visible in the caller's org. */
export async function assertContactVisible(
  tx: Tx,
  auth: Authorization,
  contactId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.contacts c
    where c.id = ${contactId}::uuid
      and c.org_id = ${auth.ctx.orgId}::uuid
      and c.deleted_at is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/**
 * Deal reference check: the company must be visible when set; the contact must be
 * visible when set and — when the deal also names a company — belong to that company.
 * Mirrors the composite FK (contact_id, company_id, org_id) so a pairing mismatch
 * fails closed with NOT_FOUND concealment instead of a 500 FK violation.
 */
export async function assertDealReferences(
  tx: Tx,
  auth: Authorization,
  companyId: string | null | undefined,
  contactId: string | null | undefined,
): Promise<void> {
  if (companyId) await assertCompanyVisible(tx, auth, companyId);
  if (!contactId) return;
  const res = await tx.execute<{ company_id: string | null }>(sql`
    select ct.company_id
    from public.contacts ct
    where ct.id = ${contactId}::uuid
      and ct.org_id = ${auth.ctx.orgId}::uuid
      and ct.deleted_at is null
  `);
  const contactCompanyId = res.rows[0]?.company_id; // undefined when invisible
  await assertTargetAffected(auth, contactCompanyId === undefined ? 0 : 1);
  if (companyId && contactCompanyId !== companyId) {
    // Same concealment as an invisible reference: the pairing is not observable.
    await assertTargetAffected(auth, 0);
  }
}
