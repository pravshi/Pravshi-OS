import type { Config } from 'drizzle-kit';

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE! },
  // RLS policies, functions, grants and triggers are hand-written SQL appended
  // to these migration files. They are never modelled in Drizzle.
} satisfies Config;
