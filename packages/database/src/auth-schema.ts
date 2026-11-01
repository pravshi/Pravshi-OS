import {
  bigint,
  boolean,
  customType,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle definitions for the Better Auth tables in the `auth` schema.
 *
 * These mirror drizzle/0013_auth_tables.sql, which remains the only thing that creates
 * them — Drizzle Kit never generates against this file, and the Better Auth CLI never
 * touches the database. A test compares every column here against the live catalogue, so
 * the two cannot drift apart quietly.
 *
 * The object keys below are Better Auth FIELD names (camelCase) and the strings are the
 * real column names (snake_case). The adapter looks fields up by key, so the library keeps
 * its vocabulary and the database keeps ours.
 */

const authSchema = pgSchema('auth');

/** Case-insensitive email, matching the database.md convention. */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const authUsers = authSchema.table('auth_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: citext('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // Enrolment, not assurance: a second factor is configured. Whether one was USED is
  // recorded on the session, not here.
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSessions = authSchema.table('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  // Written once when the session is minted; never upgraded afterwards.
  aal: text('aal').notNull().default('aal1'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authAccounts = authSchema.table('auth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  password: text('password'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authVerifications = authSchema.table('auth_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * TOTP seed and recovery codes, both encrypted with the application secret before they
 * reach this table. Nothing in the application reads either column.
 */
export const authTwoFactors = authSchema.table('auth_two_factors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const authRateLimits = authSchema.table('auth_rate_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  // Better Auth stores epoch milliseconds here, not a timestamp.
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

/**
 * Keyed by the `modelName` each table is configured with in server.ts. The Better Auth
 * Drizzle adapter resolves a model to a table through exactly these keys, so the names here
 * and the modelName values there must agree.
 */
export const authDbSchema = {
  auth_users: authUsers,
  auth_sessions: authSessions,
  auth_accounts: authAccounts,
  auth_verifications: authVerifications,
  auth_rate_limits: authRateLimits,
  auth_two_factors: authTwoFactors,
};
