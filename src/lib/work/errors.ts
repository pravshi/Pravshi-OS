/**
 * PostgreSQL error introspection for the work services (Phase 4).
 * Same pattern as src/lib/crm/pipelines.ts: drizzle-orm wraps the
 * node-postgres driver error in a DrizzleQueryError, so the SQLSTATE and the
 * constraint name may live on `error` or on `error.cause` — check both.
 */

export type PgFields = {
  code: string;
  constraint?: unknown;
  detail?: string;
};

export function pgFieldsOf(error: unknown): PgFields | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const record = candidate as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
    } | null;
    const code = record?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return {
        code,
        constraint: record?.constraint,
        detail: typeof record?.detail === 'string' ? record.detail : undefined,
      };
    }
  }
  return null;
}

/** True when the error is a Postgres error with the given SQLSTATE. */
export function isPgCode(error: unknown, code: string): boolean {
  return pgFieldsOf(error)?.code === code;
}
