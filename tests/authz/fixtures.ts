import { createHmac } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { auth, MIN_PASSWORD_LENGTH } from '@/lib/auth/server';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from '@/lib/auth/schema';
import { AuthorizationError } from '@/lib/authz/errors';

/**
 * Shared fixtures for the Task 1.15 authorization suites.
 *
 * Everything here is real: organizations, departments, people, engagements, role assignments,
 * Better Auth logins, sessions and TOTP factors. Nothing stubs an authorization decision. The
 * owner connection seeds rows; every assertion is then made through requirePermission().
 */

export const PASSWORD = 'correct horse battery staple';

export const runId = () => Math.random().toString(36).slice(2, 8);

export const ownerPool = () => new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Stands in for the invitation flow, which does not exist yet — as in the Task 1.12 suites. */
const provisioning = betterAuth({
  appName: 'PRAVSHI OS test provisioning',
  baseURL: 'http://localhost:3000',
  secret: 'test-only-provisioning-secret-at-least-32-chars',
  database: drizzleAdapter(authDb, { provider: 'pg', schema: authDbSchema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    autoSignIn: false,
  },
  session: {
    modelName: 'auth_sessions',
    additionalFields: { aal: { type: 'string', defaultValue: 'aal1', input: false } },
  },
  user: { modelName: 'auth_users' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  advanced: { database: { generateId: 'uuid' } },
  plugins: [twoFactor({ schema: { twoFactor: { modelName: 'auth_two_factors' } } })],
});

export async function mkOrg(owner: Pool, slug: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.organizations (name, slug) values ($1, $2) returning id`,
    [`Authz ${slug}`, slug],
  );
  return rows[0]!.id;
}

export async function mkDept(owner: Pool, org: string, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
    [org, code, `Dept ${code}`],
  );
  return rows[0]!.id;
}

export async function mkPerson(
  owner: Pool,
  org: string,
  name: string,
  opts: { authUserId?: string | null; status?: string } = {},
): Promise<string> {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.people (org_id, code, full_legal_name, person_status, auth_user_id)
     values ($1, $2, $3, $4::public.person_status, $5) returning id`,
    [org, code, name, opts.status ?? 'ACTIVE', opts.authUserId ?? null],
  );
  return rows[0]!.id;
}

export async function mkEngagement(
  owner: Pool,
  org: string,
  person: string,
  dept: string,
  status = 'ACTIVE',
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.engagements (org_id, person_id, department_id, engagement_type, status, start_date)
     values ($1, $2, $3, 'EMPLOYEE', $4::public.engagement_status, current_date) returning id`,
    [org, person, dept, status],
  );
  return rows[0]!.id;
}

export async function roleId(owner: Pool, org: string, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `select id from public.roles where org_id = $1 and key = $2`,
    [org, key],
  );
  return rows[0]!.id;
}

/**
 * Assigns a role from the owner connection with no identity in the transaction. For a protected
 * role this rides the Task 1.7 genesis branch, so it works once per organization: give each
 * organization at most one protected grant made this way.
 */
export async function grantRole(owner: Pool, person: string, org: string, key: string) {
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, await roleId(owner, org, key), org],
  );
}

/** A custom, unprotected role carrying exactly the given (permission, scope) grants. */
export async function mkCustomRole(
  owner: Pool,
  org: string,
  key: string,
  grants: [permission: string, scope: string][],
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.roles (org_id, key, name) values ($1, $2, $3) returning id`,
    [org, key, `Custom ${key}`],
  );
  const role = rows[0]!.id;
  for (const [permission, scope] of grants) {
    await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, $2::public.access_scope from public.permissions p where p.key = $3`,
      [role, scope, permission],
    );
  }
  return role;
}

export async function assignRoleId(owner: Pool, person: string, org: string, role: string) {
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
}

export async function mkLogin(label: string, run: string): Promise<{ email: string; id: string }> {
  const email = `${label}.${run}@example.test`.toLowerCase();
  const created = await provisioning.api.signUpEmail({
    body: { email, password: PASSWORD, name: label },
  });
  return { email, id: created.user.id };
}

/** Every cookie a response sets — a 2FA flow sets more than one. */
export function cookieFrom(res: Response): string {
  const header = res.headers as Headers & { getSetCookie?: () => string[] };
  const all =
    typeof header.getSetCookie === 'function'
      ? header.getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;]+?=)/);
  return all
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

export const headersFor = (cookie: string, extra: Record<string, string> = {}) =>
  new Headers({ cookie, ...extra });

export async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return cookieFrom(res);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238, independent of the library. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Enrols TOTP through the real instance and returns the aal2 session it mints. The session the
 * enrolment started from is rotated away by the library, so the input cookie is dead afterwards.
 */
export async function enrolTotp(cookie: string): Promise<{ cookie: string; secret: string }> {
  const enabled = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: headersFor(cookie),
  });
  if (enabled.method !== 'totp') throw new Error('expected a TOTP enrolment');
  const secret = new URL(enabled.totpURI).searchParams.get('secret')!;
  const verified = (await auth.api.verifyTOTP({
    body: { code: totp(secret) },
    headers: headersFor(cookie),
    asResponse: true,
  })) as Response;
  if (!verified.ok) throw new Error(`enrolment verification failed: ${verified.status}`);
  return { cookie: cookieFrom(verified), secret };
}

export interface Account {
  personId: string;
  authUserId: string;
  email: string;
  /** aal2 when `mfa` was requested, aal1 otherwise. */
  cookie: string;
  secret?: string;
}

/** A person with a login, the given roles and engagement, signed in (and enrolled if asked). */
export async function mkAccount(
  owner: Pool,
  input: {
    org: string;
    dept: string;
    run: string;
    label: string;
    roles?: string[];
    customRoles?: string[];
    engagement?: string | null;
    mfa?: boolean;
  },
): Promise<Account> {
  const login = await mkLogin(input.label, input.run);
  const personId = await mkPerson(owner, input.org, input.label, { authUserId: login.id });
  if (input.engagement !== null) {
    await mkEngagement(owner, input.org, personId, input.dept, input.engagement ?? 'ACTIVE');
  }
  for (const key of input.roles ?? []) await grantRole(owner, personId, input.org, key);
  for (const role of input.customRoles ?? []) await assignRoleId(owner, personId, input.org, role);
  const cookie = await signIn(login.email);
  if (!input.mfa) return { personId, authUserId: login.id, email: login.email, cookie };
  const enrolled = await enrolTotp(cookie);
  return {
    personId,
    authUserId: login.id,
    email: login.email,
    cookie: enrolled.cookie,
    secret: enrolled.secret,
  };
}

/** What a thrown AuthorizationError looks like to a test, or SUCCEEDED. */
export async function outcomeOf(
  promise: Promise<unknown>,
): Promise<{ code: string; status?: number; requestId?: string; assurance?: unknown }> {
  try {
    await promise;
    return { code: 'SUCCEEDED' };
  } catch (error) {
    const e = error as { code?: string; status?: number; requestId?: string; assurance?: unknown };
    return {
      code: e.code ?? 'THREW',
      status: e.status,
      requestId: e.requestId,
      assurance: e.assurance,
    };
  }
}

/** The AuthorizationError a refused request threw. Fails the calling test if it was allowed. */
export async function refusal(promise: Promise<unknown>): Promise<AuthorizationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthorizationError) return error;
    throw error;
  }
  throw new Error('expected a refusal, but the request was authorized');
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. The application pool holds five
 * connections and times out a queued checkout after ten seconds, so suites fan out through this
 * rather than through an unbounded Promise.all.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
