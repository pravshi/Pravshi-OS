import type { Config } from 'drizzle-kit';

export default {
  schema: './packages/database/src/schema.ts',
  out: './packages/database/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE! },
  // RLS policies, functions, grants and triggers are hand-written SQL appended
  // to these migration files. They are never modelled in Drizzle.
} satisfies Config;
