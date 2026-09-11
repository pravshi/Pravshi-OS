import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';

/**
 * A code type prefix: 2-8 uppercase letters, e.g. EMP, INT, CTR.
 * Kept generic on purpose — new prefixes need no migration and no code change here.
 */
const CODE_TYPE = /^[A-Z]{2,8}$/;
const PERIOD = /^[0-9]{4}$/;

export interface IdentityCodeInput {
  /** 2-8 uppercase letters, e.g. 'EMP'. */
  codeType: string;
  /** Four-digit year. Defaults to the current UTC year. */
  period?: string;
}

/**
 * Allocates the next immutable identity code, e.g. `EMP-2026-0001`.
 *
 * Goes through withAuthorizedDb() like every other database access — there is no second
 * path. The organization is taken from the authorized context rather than accepted as an
 * argument, so a caller cannot allocate a code against an organization it is not acting
 * for.
 *
 * The counter table itself is unreachable: no application role holds privileges on it,
 * and RLS denies it besides. `authz.next_identity_code()` is the only writer, and it is
 * atomic under concurrency, so two simultaneous callers can never receive the same code.
 *
 * Validation is duplicated here and in SQL deliberately. This copy gives a fast, typed
 * failure at the call site; the SQL copy is the one that actually protects the table,
 * because it holds even if this function is bypassed.
 */
export async function nextIdentityCode(
  ctx: AuthContext,
  { codeType, period }: IdentityCodeInput,
): Promise<string> {
  if (!CODE_TYPE.test(codeType)) {
    throw new Error('nextIdentityCode: codeType must be 2-8 uppercase letters');
  }
  const resolvedPeriod = period ?? String(new Date().getUTCFullYear());
  if (!PERIOD.test(resolvedPeriod)) {
    throw new Error('nextIdentityCode: period must be a four-digit year');
  }

  return withAuthorizedDb(ctx, async (tx) => {
    const result = await tx.execute<{ code: string }>(
      sql`select authz.next_identity_code(${ctx.orgId}::uuid, ${codeType}, ${resolvedPeriod}) as code`,
    );
    const code = result.rows[0]?.code;
    if (typeof code !== 'string') {
      throw new Error('nextIdentityCode: the database returned no code');
    }
    return code;
  });
}
