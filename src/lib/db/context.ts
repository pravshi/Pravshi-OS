/** Authentication assurance level. 'aal2' means MFA was satisfied this session. */
export type Aal = 'aal1' | 'aal2';

/**
 * The identity a database transaction runs under.
 * Phase 1 derives this from the Better Auth session; Phase 0 constructs it in tests.
 */
export interface AuthContext {
  personId: string;
  orgId: string;
  aal: Aal;
}
