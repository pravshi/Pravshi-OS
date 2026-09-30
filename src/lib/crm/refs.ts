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
 * Track B adds activities: their (entity_type, entity_id) link is polymorphic with
 * no cross-table foreign key by design (plan §3), so the probe is the ONLY
 * enforcement point — a random UUID entity_id succeeds at the database level and
 * must fail closed here instead.
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

/** The referenced deal must be live and visible in the caller's org.
 * Track B (activities): the polymorphic activity link names a deal by UUID with
 * no foreign key, so this probe is the only enforcement point. */
export async function assertDealVisible(
  tx: Tx,
  auth: Authorization,
  dealId: string,
): Promise<void> {
  const res = await tx.execute(sql`
    select 1
    from public.deals d
    where d.id = ${dealId}::uuid
      and d.org_id = ${auth.ctx.orgId}::uuid
      and d.deleted_at is null
  `);
  await assertTargetAffected(auth, res.rowCount ?? 0);
}

/**
 * Activity reference check (Track B): the polymorphic (entity_type, entity_id)
 * link names exactly one CRM record, which must be live and visible in the
 * caller's org. An invisible reference fails through assertTargetAffected —
 * NOT_FOUND concealment, no existence oracle.
 */
export async function assertActivityReferences(
  tx: Tx,
  auth: Authorization,
  entityType: 'company' | 'contact' | 'deal',
  entityId: string,
): Promise<void> {
  switch (entityType) {
    case 'company':
      await assertCompanyVisible(tx, auth, entityId);
      return;
    case 'contact':
      await assertContactVisible(tx, auth, entityId);
      return;
    case 'deal':
      await assertDealVisible(tx, auth, entityId);
      return;
  }
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
