import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWithWake } from './pool';
import type { AuthContext } from './context';

type DrizzleClient = ReturnType<typeof drizzle>;

/** The transaction handle handed to every callback. Exported so callers can type helpers. */
export type Tx = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];

/**
 * THE ONLY PATH TO POSTGRES.
 *
 * The sequence is fixed and each step exists for a reason:
 *
 *   connection establishment  → via connectWithWake(), which retries ONLY the
 *                               connect, because a suspended Neon compute is
 *                               expected rather than exceptional
 *   transaction               → SET LOCAL is transaction-scoped, so there must
 *                               be a transaction for identity to live in
 *   SET LOCAL identity        → never session-scoped SET: pooled connections are
 *                               reused, and a session setting would carry one
 *                               person's identity into the next person's query
 *   callback                  → the caller's work, run under that identity
 *   commit / rollback         → automatic; the context dies with the transaction
 *
 * Two absolutes:
 *
 *   1. The business work is NEVER retried. A connection lost mid-transaction was
 *      rolled back, but one lost mid-COMMIT is genuinely ambiguous, and replaying
 *      it can double-write. Retries belong on the connect, and nowhere else.
 *   2. No query runs outside this helper. Without context, current_setting()
 *      returns NULL, every policy evaluates false, and the query returns zero
 *      rows — fail-closed, which is the correct failure.
 */
export async function withAuthorizedDb<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.person_id', ${ctx.personId}, true),
          set_config('app.org_id',    ${ctx.orgId},    true),
          set_config('app.aal',       ${ctx.aal},      true)
      `);
      return fn(tx);
    });
  } finally {
    // Always returned, including after a rollback. A leaked connection exhausts
    // the pool after `max` requests and the app hangs with no error.
    client.release();
  }
}
