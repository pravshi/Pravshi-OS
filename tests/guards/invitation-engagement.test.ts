import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Accepting an invitation must leave the invitee with a live engagement.
 *
 * authz.is_active() requires an ACTIVE engagement, and every business-data RLS
 * policy builds on it. A brand-new person arrives with no engagement, so the
 * invitation carries the engagement the acceptance creates (migration 0018), and
 * accept_invitation (0019) creates it as ACTIVE. This guard pins the three halves
 * of that contract together: the columns exist and are all-or-nothing, the accept
 * function creates the engagement and refuses when the terms are missing, and the
 * service requires the terms whenever the invitee has no live engagement.
 *
 * Like the other guards this is a heuristic over source text, not a type proof: it
 * fails closed on any shape it does not recognise.
 */

const MIGRATION_18 = readFileSync(
  join(process.cwd(), 'drizzle/0018_invitations_and_login_events.sql'),
  'utf8',
);
const MIGRATION_19 = readFileSync(
  join(process.cwd(), 'drizzle/0019_invitation_accept_functions.sql'),
  'utf8',
);
const SERVICE = readFileSync(join(process.cwd(), 'src/lib/invitations/service.ts'), 'utf8');

describe('invitation carries the engagement the acceptance creates', () => {
  it('0018: invitations has engagement_type, department_id, start_date', () => {
    expect(MIGRATION_18).toMatch(/engagement_type public\.engagement_type/);
    expect(MIGRATION_18).toMatch(/^\s+department_id uuid,/m);
    expect(MIGRATION_18).toMatch(/^\s+start_date date,/m);
  });

  it('0018: engagement terms are all-or-nothing and the department is org-bound', () => {
    expect(MIGRATION_18).toMatch(/invitations_engagement_all_or_nothing/);
    expect(MIGRATION_18).toMatch(/invitations_department_same_org/);
    expect(MIGRATION_18).toMatch(
      /foreign key \(department_id, org_id\) references public\.departments \(id, org_id\)/,
    );
  });

  it('0018: engagement terms are immutable after issuance', () => {
    expect(MIGRATION_18).toMatch(/new\.engagement_type is distinct from old\.engagement_type/);
    expect(MIGRATION_18).toMatch(/new\.department_id is distinct from old\.department_id/);
    expect(MIGRATION_18).toMatch(/new\.start_date is distinct from old\.start_date/);
  });

  it('0019: accept creates an ACTIVE engagement when the person has none', () => {
    expect(MIGRATION_19).toMatch(/insert into public\.engagements/);
    expect(MIGRATION_19).toMatch(/v_inv\.engagement_type, 'ACTIVE',/);
    expect(MIGRATION_19).toMatch(/v_engagement_created := true/);
  });

  it('0019: accept refuses when the person has no engagement and the invitation carries none', () => {
    expect(MIGRATION_19).toMatch(/this invitation carries no engagement and the person has none/);
  });

  it('service: engagement terms required whenever the invitee has no live engagement', () => {
    expect(SERVICE).toMatch(/ENGAGEMENT_REQUIRED/);
    expect(SERVICE).toMatch(/needsEngagement/);
  });

  it('service: the department must exist in the invitation org', () => {
    expect(SERVICE).toMatch(/DEPARTMENT_NOT_FOUND/);
    expect(SERVICE).toMatch(/from public\.departments d/);
  });
});

describe('invitation accept grants the EMPLOYEE baseline (blueprint R21)', () => {
  it('0019: accept grants EMPLOYEE alongside the invitation roles', () => {
    expect(MIGRATION_19).toMatch(/r\.key = 'EMPLOYEE'/);
    expect(MIGRATION_19).toMatch(
      /insert into public\.person_roles \(person_id, role_id, org_id, granted_by\)\s*values \(v_new_person_id, v_role_id, v_inv\.org_id, v_invited_by\)\s*on conflict do nothing;/,
    );
  });

  it('0019: accept fails closed when the org has no active system EMPLOYEE role', () => {
    expect(MIGRATION_19).toMatch(/the organization has no active system EMPLOYEE role/);
  });
});
