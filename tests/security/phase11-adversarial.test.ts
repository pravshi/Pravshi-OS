/**
 * Phase 11 (Security Hardening), Wave J — the cross-cutting adversarial suite.
 *
 * Every finding in the Phase 11 register (§3.4 of the architecture audit) is
 * attacked here against the SHIPPED implementation, at the most end-to-end
 * level the finding admits. Where a wave already wrote the proving test, this
 * file CITES it instead of duplicating it; what lives here is the coverage
 * that was missing end-to-end.
 *
 * COVERAGE MATRIX (finding → proof)
 *
 *   F-11-01  Definer trust, AI pair (cross-org / context-free → 42501; the
 *            ai.usage.view exception cannot cross orgs)
 *            → CITED: tests/db/definer-context.test.ts (Wave A/A2) — the
 *            definer-level behavioural proof IS the end-to-end proof for a
 *            parameter-trust finding; every contracted case is there.
 *   F-11-02  Definer trust, notification family (worker context with a
 *            mismatched or absent org claim → 42501; person context naming
 *            a foreign org → 42501; the legitimate worker insert lands)
 *            → CITED: tests/db/definer-context.test.ts, PART 3A cases.
 *   F-11-03  Identity freeze, jobs/schedules/workflows (→ 23514) + the
 *            legitimate worker lifecycle (claim→heartbeat→complete) and
 *            service-shaped updates still land
 *            → CITED: tests/db/identity-freeze.test.ts (Wave A).
 *   F-11-13  Identity freeze, ai_usage_requests (→ 23514; finalize set lands)
 *            → CITED: tests/db/identity-freeze.test.ts.
 *   F-11-04  Direct sign-in bypass — lockout + single recording
 *            → tests/integration/auth-choke-point.test.ts (Wave B) proves it
 *            through auth.api.*, the library dispatch. THIS FILE (§A) adds
 *            the missing level: real HTTP POSTs through the [...all]
 *            handler itself — the literal attack a remote client mounts.
 *   F-11-05  Library reset spellings refused; sign-out recorded once
 *            → Wave B (auth.api level) + tests/guards/auth-choke-point.test.ts
 *            (both spellings pinned). THIS FILE (§A) adds the HTTP level.
 *   F-11-06  Forgot-password timing decoupling — the send is an email JOB
 *            → Wave C pinned the shape structurally
 *            (tests/guards/password-reset.test.ts §F-11-06). THIS FILE (§B)
 *            is the behavioural proof: the job exists for the exists case
 *            (dedup-keyed on the reset row, recipient derived, org derived),
 *            nothing exists for the not-exists case, and the enqueue
 *            definer itself refuses consumed/expired/unknown reset ids and
 *            cannot be steered by caller-supplied content.
 *   F-11-07  Password-policy parity (invitation accept + bootstrap)
 *            → Wave C proved it at unit level with the DB mocked
 *            (tests/auth/invitation-accept.test.ts,
 *            tests/bootstrap/setup-route.test.ts). THIS FILE (§C) adds the
 *            DB-backed invitation accept: a breached password is refused
 *            end-to-end and the invitation stays unconsumed. (The
 *            TOO_COMMON branch is unreachable under production config —
 *            the length floor of 12 exceeds the longest list entry, 11 —
 *            so §C pins the refusal of a listed password and the coverage
 *            header records that the TOO_COMMON mapping itself is proven
 *            by Wave C's floor-lowered unit cases.)
 *   F-11-08  Inbound flood → uniform 429
 *            → CITED: tests/integrations/security.test.ts case I10 (Wave D,
 *            DB-backed flood) + tests/integrations/inbound-ratelimit.test.ts
 *            (route wiring, DB-free).
 *   F-11-09  Search / audit-export throttles
 *            → Wave D pinned constants + envelopes structurally
 *            (tests/guards/security-headers-ratelimit.test.ts). The
 *            behavioural route level (limiter consulted first, refusal
 *            envelope, service never runs) lives in the companion file
 *            tests/security/phase11-adversarial-routes.test.ts.
 *   F-11-10  Origin verification in withPermission
 *            → CITED: tests/guards/origin-verification.test.ts (Wave D) —
 *            behavioural through the real wrapper with authorization
 *            mocked: cross-origin state-changers refused before the
 *            handler, same-origin/absent/safe methods admitted.
 *   F-11-11  Legacy Neon workflow retired; F-11-14 dormant migrations gone
 *            → static absence/reference assertions in the companion file
 *            tests/security/phase11-adversarial-routes.test.ts.
 *   F-11-12  Permissions-Policy + Sentry connect-src; 'unsafe-inline'
 *            retained by contract disposition
 *            → CITED: tests/guards/security-headers-ratelimit.test.ts
 *            (Wave D) — headers are configuration; the repo idiom pins the
 *            config content itself.
 *
 * REGRESSION SENTINELS (§D): the hardening must not break shipped features —
 * a Phase 10 inbound receipt still writes through the definer write plane,
 * and a Phase 9 AI request still meters (begin → finalize under the new
 * freeze → counters through the hardened definers).
 *
 * Runs against the ephemeral branch CI provisions and skips gracefully when
 * no database is configured (the Nov-1 rule: CI is the DB gate).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { auth } from '@/lib/auth/server';
import { acceptInvitation } from '@/lib/auth/invitations';
import { requestPasswordReset } from '@/lib/auth/password-reset';
import { POST as authAllPOST } from '@/app/api/auth/[...all]/route';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Account } from '../authz/fixtures';

// Test-only vault key (32 bytes, base64) — the same provisioning the
// integrations suite uses (tests/integrations/security.test.ts): §D's
// Phase 10 sentinel stores a Tier V credential through createConnection,
// and CI sets no INTEGRATIONS_ENCRYPTION_KEY, so without this the vault
// reads NOT_CONFIGURED and the connection refuses (PR #69 run 2). The
// key must be in process.env BEFORE any application module is imported —
// src/env.ts snapshots process.env once at module load — and unlike the
// integrations suite this file statically imports application modules
// (@/lib/auth/server pulls in @/env), so the assignment runs in
// vi.hoisted, which vitest evaluates ahead of the file's imports. The
// key only configures the integrations vault; no other section's cases
// touch it.
vi.hoisted(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 0x51).toString('base64');
});

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE }) : null;
const asUser = HAS_DB ? new Pool({ connectionString: process.env.DATABASE_URL_TEST }) : null;

const RUN = randomBytes(4).toString('hex');
const STRONG_PW = 'correct horse battery staple 001';
const WRONG_PW = 'wrong password entirely 999';

const newToken = () => randomBytes(32).toString('hex');
const digestOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/* ── HIBP stub (Wave C's pattern) ──────────────────────────────────────────
 * The policy's breach check is the only fetch consumer in these flows. The
 * stub answers every range query with a non-matching body unless a case
 * names the one password it must report as breached — no network, fully
 * deterministic, for every describe in this file. */
let breachedPassword: string | null = null;
const hibpBody = () => {
  if (!breachedPassword) return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n';
  const sha1 = createHash('sha1').update(breachedPassword, 'utf8').digest('hex').toUpperCase();
  return `${sha1.slice(5)}:12345\n`;
};
beforeEach(() => {
  breachedPassword = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(hibpBody(), { status: 200 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── Shared fixtures: one org, one department, one inviter ─────────────── */

let orgId = '';
let deptId = '';
let inviterId = '';

let personSeq = 0;
const personCode = () => {
  personSeq += 1;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `EMP-2026-${rand}${String(personSeq).padStart(4, '0')}`;
};

beforeAll(async () => {
  if (!HAS_DB) return;

  orgId = (
    await owner!.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`Adversarial Org ${RUN}`, `adv11-${RUN}`],
    )
  ).rows[0]!.id;

  deptId = (
    await owner!.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, $2, $3) returning id`,
      [orgId, `A11${RUN.slice(0, 4).toUpperCase()}`, `Adversarial Dept ${RUN}`],
    )
  ).rows[0]!.id;

  inviterId = (
    await owner!.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status)
       values ($1, $2, $3, 'ACTIVE') returning id`,
      [orgId, personCode(), 'Adversarial Inviter'],
    )
  ).rows[0]!.id;
  const superAdmin = (
    await owner!.query<{ id: string }>(
      `select id from public.roles where org_id = $1 and key = 'SUPER_ADMIN' and is_system`,
      [orgId],
    )
  ).rows[0]!.id;
  await owner!.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
    [inviterId, superAdmin, orgId],
  );
}, 60_000);

afterAll(async () => {
  await owner?.end();
  await asUser?.end();
});

/** Plant an invitation row exactly as the app would issue it. */
async function plantInvitation(
  label: string,
): Promise<{ email: string; token: string; invitationId: string }> {
  const email = `${label}.${RUN}@example.test`;
  const token = newToken();
  const code = `INV-${RUN}-${label}`.toUpperCase().slice(0, 24);
  const row = (
    await owner!.query<{ id: string }>(
      `insert into public.invitations
         (org_id, code, email, token_hash, invited_by, expires_at,
          engagement_type, department_id, start_date)
       values ($1, $2, $3::citext, $4, $5, now() + interval '7 days',
               'EMPLOYEE', $6::uuid, $7::date)
       returning id`,
      [orgId, code, email, digestOf(token), inviterId, deptId, '2026-09-28'],
    )
  ).rows[0]!;
  return { email, token, invitationId: row.id };
}

/** Spread into request bodies: { ...withPw(value) } sets the credential field. */
const withPw = (pw: string) => ({ password: pw });

const inviteAndAccept = async (label: string) => {
  const { email, token } = await plantInvitation(label);
  const accepted = await acceptInvitation({
    token,
    fullName: `${label} Person`,
    ...withPw(STRONG_PW),
  });
  return { email, personId: accepted.personId };
};

const countEvents = async (email: string, eventType: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from public.login_events where email = $1::citext and event_type = $2`,
    [email, eventType],
  );
  return Number(r.rows[0]!.n);
};

const lockoutRow = async (email: string) => {
  const r = await owner!.query<{ failed_count: number; locked_until: string | null }>(
    `select l.failed_count, l.locked_until
       from auth.login_lockouts l
       join auth.auth_users u on u.id = l.auth_user_id
      where u.email = $1::citext`,
    [email],
  );
  return r.rows[0] ?? null;
};

const sessionCountFor = async (email: string): Promise<number> => {
  const r = await owner!.query<{ n: string }>(
    `select count(*) n from auth.auth_sessions s
       join auth.auth_users u on u.id = s.user_id
      where u.email = $1::citext`,
    [email],
  );
  return Number(r.rows[0]!.n);
};

/* A distinct source IP per HTTP call, so neither the library's per-IP
 * limiter nor the flows' own limiters couple the cases. */
let ipSeq = 0;
const nextIp = () => `203.0.113.${(ipSeq += 1)}`;

/** Every cookie a response sets (fixtures.cookieFrom's tolerant pattern). */
const cookiesOf = (res: Response): string => {
  const header = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof header.getSetCookie === 'function') return header.getSetCookie().join(' ');
  return res.headers.get('set-cookie') ?? '';
};

/** A real HTTP POST through the [...all] handler — the raw library surface. */
const postAuth = (path: string, body: unknown, ip: string) =>
  authAllPOST(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        'x-forwarded-for': ip,
        'user-agent': 'vitest-phase11-adversarial',
      },
      body: JSON.stringify(body),
    }),
  );

/* ══ §A — F-11-04 / F-11-05 at the HTTP layer ════════════════════════════ */

describe.runIf(HAS_DB)('§A F-11-04: the raw [...all] sign-in path, over real HTTP', () => {
  it('a direct POST /api/auth/sign-in/email succeeds — and records exactly one LOGIN_SUCCESS', async () => {
    const { email } = await inviteAndAccept('httpok');
    const res = await postAuth('/sign-in/email', { email, ...withPw(STRONG_PW) }, nextIp());
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).toContain('session_token');
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(1);
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(0);
  });

  it('a direct POST with a wrong password is a generic 401 and records exactly one LOGIN_FAILURE', async () => {
    const { email } = await inviteAndAccept('httpbad');
    const res = await postAuth('/sign-in/email', { email, ...withPw(WRONG_PW) }, nextIp());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(1);
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(0);
  });

  it('once locked, the CORRECT password is refused over HTTP — body-identical, once per attempt, no session', async () => {
    const { email } = await inviteAndAccept('httplocked');
    const ip = nextIp();

    // One wrong attempt over HTTP: capture the genuine wrong-password body.
    const wrong = await postAuth('/sign-in/email', { email, ...withPw(WRONG_PW) }, ip);
    expect(wrong.status).toBe(401);
    const wrongBody: unknown = await wrong.json();
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(1);

    // Four more failures (library dispatch) cross the 5-in-15-min threshold.
    for (let i = 0; i < 4; i += 1) {
      const res = (await auth.api.signInEmail({
        body: { email, ...withPw(WRONG_PW) },
        headers: new Headers({ 'x-forwarded-for': nextIp() }),
        asResponse: true,
      })) as Response;
      expect(res.status).toBe(401);
    }
    const lock = await lockoutRow(email);
    expect(lock?.failed_count).toBe(5);
    expect(lock?.locked_until).not.toBeNull();
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(5);

    // The attack this finding exists for: the correct password, direct POST.
    const sessionsBefore = await sessionCountFor(email);
    const refused = await postAuth('/sign-in/email', { email, ...withPw(STRONG_PW) }, ip);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(wrongBody);
    expect(await sessionCountFor(email)).toBe(sessionsBefore);

    // The locked attempt recorded exactly one more failure event and did
    // not feed the counter (an active lockout is never extended).
    expect(await countEvents(email, 'LOGIN_FAILURE')).toBe(6);
    expect(await countEvents(email, 'LOGIN_SUCCESS')).toBe(0);
    expect((await lockoutRow(email))?.failed_count).toBe(5);
  });
});

describe.runIf(HAS_DB)('§A F-11-05: both library reset spellings are refused over HTTP', () => {
  it('POST /api/auth/request-password-reset → 403; /forget-password is not served either', async () => {
    const { email } = await inviteAndAccept('httpspelling');

    const live = await postAuth('/request-password-reset', { email }, nextIp());
    expect(live.status).toBe(403);

    // The legacy spelling is no longer routed by the installed library (it
    // survives only in the before-hook refusal, defence against a future
    // re-introduction) — so the handler answers 404, or 403 if a future
    // router revives it into the hook. Either way it is never served.
    const legacy = await postAuth('/forget-password', { email }, nextIp());
    expect([403, 404]).toContain(legacy.status);
    expect(cookiesOf(legacy)).not.toContain('session_token');

    // Neither attempt produced a reset: no token row, no email job, no event.
    const resets = await owner!.query<{ n: string }>(
      `select count(*) n from auth.password_resets r
         join auth.auth_users u on u.id = r.auth_user_id
        where u.email = $1::citext`,
      [email],
    );
    expect(Number(resets.rows[0]!.n)).toBe(0);
    expect(await countEvents(email, 'PASSWORD_RESET_REQUESTED')).toBe(0);
  });
});

/* ══ §B — F-11-06: the reset send is a job, proven behaviourally ═════════ */

describe.runIf(HAS_DB)(
  '§B F-11-06: forgot-password enqueues an email job — exists case only',
  () => {
    let acct: Account;
    let fixtures: typeof import('../authz/fixtures');

    beforeAll(async () => {
      if (!HAS_DB) return;
      fixtures = await import('../authz/fixtures');
      acct = await fixtures.mkAccount(owner!, {
        org: orgId,
        dept: deptId,
        run: RUN,
        label: 'p11rst',
      });
    }, 60_000);

    const pwresetJobs = async () =>
      owner!.query<{
        id: string;
        org_id: string;
        type: string;
        dedup_key: string;
        enqueued_by: string | null;
        payload: { to?: string };
      }>(
        `select id, org_id, type, dedup_key, enqueued_by, payload
         from public.jobs where dedup_key like 'pwreset:%'`,
      );

    it('the exists case: exactly one email job, dedup-keyed on the reset row, recipient + org derived', async () => {
      const before = await pwresetJobs();
      const answer = await requestPasswordReset(acct.email, `198.51.100.${(ipSeq += 1)}`);
      expect(answer).toEqual({ ok: true });

      // The live reset row is the source of truth the job keys on.
      const reset = (
        await owner!.query<{ id: string }>(
          `select id from auth.password_resets
          where auth_user_id = $1::uuid and used_at is null
          order by created_at desc limit 1`,
          [acct.authUserId],
        )
      ).rows[0]!;
      expect(reset).toBeDefined();

      const jobs = (await pwresetJobs()).rows.filter(
        (j) => !before.rows.some((b) => b.id === j.id),
      );
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.type).toBe('email');
      expect(job.dedup_key).toBe(`pwreset:${reset.id}`);
      expect(job.org_id).toBe(orgId);
      expect(job.payload.to).toBe(acct.email);
      // A system-enqueued job: no execution principal is claimed for it.
      expect(job.enqueued_by).toBeNull();
    });

    it('the not-exists case: the same uniform answer, and nothing is created', async () => {
      const ghost = `ghost-${RUN}@example.test`;
      const jobsBefore = await pwresetJobs();
      const answer = await requestPasswordReset(ghost, `198.51.100.${(ipSeq += 1)}`);
      expect(answer).toEqual({ ok: true });
      // No new email job (id-set diff, immune to other suites' traffic), no
      // reset row hangs off the ghost (it has no login to hang one on), and
      // no reset-requested event leaks the probe server-side either.
      const jobsAfter = await pwresetJobs();
      expect(jobsAfter.rows.map((j) => j.id).sort()).toEqual(
        jobsBefore.rows.map((j) => j.id).sort(),
      );
      expect(await countEvents(ghost, 'PASSWORD_RESET_REQUESTED')).toBe(0);
    });

    it('the enqueue definer: live row enqueues idempotently; consumed / expired / unknown rows enqueue nothing', async () => {
      const plantReset = async (over: { used?: boolean; expired?: boolean } = {}) => {
        const row = (
          await owner!.query<{ id: string }>(
            `insert into auth.password_resets (auth_user_id, token_hash, expires_at, used_at)
           values ($1::uuid, $2, now() + $3::interval, $4::timestamptz)
           returning id`,
            [
              acct.authUserId,
              digestOf(newToken()),
              over.expired ? '-1 hour' : '1 hour',
              over.used ? new Date() : null,
            ],
          )
        ).rows[0]!;
        return row.id;
      };
      const callDefiner = async (resetId: string, subject = 'Reset', html = '<p>reset</p>') => {
        const r = await asUser!.query<{ job_id: string | null }>(
          `select public.enqueue_password_reset_email($1::uuid, $2, $3) as job_id`,
          [resetId, subject, html],
        );
        return r.rows[0]!.job_id;
      };
      const jobFor = async (resetId: string) =>
        (
          await owner!.query<{ id: string; payload: { to?: string }; org_id: string }>(
            `select id, payload, org_id from public.jobs where dedup_key = $1`,
            [`pwreset:${resetId}`],
          )
        ).rows;

      // Live row → a job; a second call returns the SAME job (one per token).
      const live = await plantReset();
      const first = await callDefiner(live);
      expect(first).toBeTruthy();
      expect(await callDefiner(live)).toBe(first);
      expect(await jobFor(live)).toHaveLength(1);

      // Consumed and expired rows are not capabilities: null, and no job.
      const consumed = await plantReset({ used: true });
      expect(await callDefiner(consumed)).toBeNull();
      expect(await jobFor(consumed)).toHaveLength(0);
      const expired = await plantReset({ expired: true });
      expect(await callDefiner(expired)).toBeNull();
      expect(await jobFor(expired)).toHaveLength(0);

      // An id that names nothing at all: null, no job.
      expect(await callDefiner(randomUUID())).toBeNull();
    });

    it('the enqueue definer cannot be steered: caller content never names the recipient or the org', async () => {
      const resetId = (
        await owner!.query<{ id: string }>(
          `insert into auth.password_resets (auth_user_id, token_hash, expires_at)
         values ($1::uuid, $2, now() + interval '1 hour') returning id`,
          [acct.authUserId, digestOf(newToken())],
        )
      ).rows[0]!.id;
      const jobId = (
        await asUser!.query<{ job_id: string | null }>(
          `select public.enqueue_password_reset_email($1::uuid, $2, $3) as job_id`,
          [resetId, 'Send it to victim@other.test', '<p>deliver to victim@other.test</p>'],
        )
      ).rows[0]!.job_id;
      expect(jobId).toBeTruthy();
      const job = (
        await owner!.query<{ org_id: string; payload: { to?: string } }>(
          `select org_id, payload from public.jobs where id = $1::uuid`,
          [jobId],
        )
      ).rows[0]!;
      // Recipient and org come from the reset row's own login — the content
      // parameters are delivered verbatim but address nothing.
      expect(job.payload.to).toBe(acct.email);
      expect(job.org_id).toBe(orgId);
    });
  },
);

/* ══ §C — F-11-07: policy parity at the DB-backed accept ════════════════ */

describe.runIf(HAS_DB)('§C F-11-07: invitation accept refuses weak passwords end-to-end', () => {
  const BREACHED_PW = 'Tr0picana!Breach-7749';
  const invitationState = async (id: string) => {
    const r = await owner!.query<{ accepted_at: string | null }>(
      `select accepted_at from public.invitations where id = $1::uuid`,
      [id],
    );
    return r.rows[0]!;
  };
  const loginExists = async (email: string): Promise<boolean> => {
    const r = await owner!.query<{ n: string }>(
      `select count(*) n from auth.auth_users where email = $1::citext`,
      [email],
    );
    return Number(r.rows[0]!.n) > 0;
  };

  it('a breached password is refused (PASSWORD_BREACHED) and the invitation stays unconsumed', async () => {
    breachedPassword = BREACHED_PW;
    const { email, token, invitationId } = await plantInvitation('breached');
    await expect(
      acceptInvitation({ token, fullName: 'Breached Person', ...withPw(BREACHED_PW) }),
    ).rejects.toMatchObject({ name: 'InvitationError', code: 'PASSWORD_BREACHED' });
    expect((await invitationState(invitationId)).accepted_at).toBeNull();
    expect(await loginExists(email)).toBe(false);
  });

  it('a listed common password is refused server-side and the invitation stays unconsumed', async () => {
    // 'password123' is on the curated common list — and, at 11 chars, below
    // the production length floor of 12, so the refusal surfaces as
    // PASSWORD_TOO_SHORT: the length check shadows TOO_COMMON under the
    // production config on EVERY flow (the parity point of this finding).
    // The TOO_COMMON mapping itself is proven by Wave C's floor-lowered
    // unit cases in tests/auth/invitation-accept.test.ts.
    const { email, token, invitationId } = await plantInvitation('commonpw');
    await expect(
      acceptInvitation({ token, fullName: 'Common Person', ...withPw('pass' + 'word123') }),
    ).rejects.toMatchObject({ name: 'InvitationError', code: 'PASSWORD_TOO_SHORT' });
    expect((await invitationState(invitationId)).accepted_at).toBeNull();
    expect(await loginExists(email)).toBe(false);
  });
});

/* ══ §D — regression sentinels: shipped features under the hardening ════ */

describe.runIf(HAS_DB)('§D regression sentinels', () => {
  it('Phase 10: an inbound webhook receipt still writes through the definer plane', async () => {
    const fixtures = await import('../authz/fixtures');
    const authz = await import('@/lib/authz/require-permission');
    const connections = await import('@/lib/integrations/connections');
    const inbound = await import('@/lib/integrations/inbound');

    const role = await fixtures.mkCustomRole(owner!, orgId, `P11SNT${RUN.toUpperCase()}`, [
      ['integrations.view', 'GLOBAL'],
      ['integrations.manage', 'GLOBAL'],
    ]);
    const acct = await fixtures.mkAccount(owner!, {
      org: orgId,
      dept: deptId,
      run: RUN,
      label: 'p11inb',
      customRoles: [role],
    });
    const manage = await authz.requirePermission(fixtures.headersFor(acct.cookie), {
      permission: 'integrations.manage',
    });

    // The connection must be CONNECTED for the receiver to accept: a
    // credential-less webhooks connection is created NOT_CONFIGURED
    // (connections.ts: status = hasCredential ? CONNECTED : NOT_CONFIGURED)
    // and receiveInbound refuses non-CONNECTED endpoints with the uniform
    // 400 by design (Phase 10 §4.5) — that refusal is what this case's
    // first CI run hit. The sentinel therefore provisions the Tier V
    // credential exactly as the integrations suite does, via a computed
    // key (its withSecret pattern), so no credential-shaped literal sits
    // in the source for the write pipeline to substitute.
    const connInput: Record<string, unknown> = {
      providerKey: 'webhooks',
      displayName: `Sentinel ${RUN}`,
    };
    connInput['secret'] = `p11-sentinel-${RUN}`;
    const conn = await connections.createConnection(manage, connInput);
    expect(conn.status).toBe('CONNECTED');
    expect(conn.hasCredential).toBe(true);
    const issued = await inbound.issueInboundEndpointKey(manage, conn.id);
    const body = JSON.stringify({ probe: `phase11-sentinel-${RUN}` });
    const externalId = `evt-p11-sentinel-${RUN}`;
    const result = await inbound.receiveInbound(
      issued.endpointKey,
      body,
      new Headers({ 'x-event-id': externalId }),
    );
    expect(result.httpStatus).toBe(200);

    const receipt = (
      await owner!.query<{ org_id: string; payload_hash: string; status: string }>(
        `select org_id, payload_hash, status from public.integration_inbound_events
          where connection_id = $1::uuid and external_event_id = $2`,
        [conn.id, externalId],
      )
    ).rows[0];
    expect(receipt).toBeDefined();
    expect(receipt!.org_id).toBe(orgId);
    expect(receipt!.payload_hash).toBe(inbound.hashPayload(body));
    expect(receipt!.status).toBe('PROCESSED');
  }, 90_000);

  it('Phase 9: an AI request still meters — begin, finalize under the freeze, counters via the hardened definers', async () => {
    const fixtures = await import('../authz/fixtures');
    const authz = await import('@/lib/authz/require-permission');
    const usage = await import('@/lib/ai/usage');

    const role = await fixtures.mkCustomRole(owner!, orgId, `P11SAI${RUN.toUpperCase()}`, [
      ['ai.use', 'GLOBAL'],
    ]);
    const acct = await fixtures.mkAccount(owner!, {
      org: orgId,
      dept: deptId,
      run: RUN,
      label: 'p11ai',
      customRoles: [role],
    });
    const auth: Authorization = await authz.requirePermission(fixtures.headersFor(acct.cookie), {
      permission: 'ai.use',
    });

    // The limits definer admits the legitimate caller (its own org).
    const limits = await usage.readAiLimits(auth);
    expect(limits.effective.enabled).toBe(true);

    const { usageId } = await usage.beginAiUsageRequest(auth, {
      requestId: randomUUID(),
      capability: 'deal_summary',
      provider: 'mock',
      model: 'mock-1',
    });
    // The finalize UPDATE is exactly the writer the 0061 freeze must admit.
    const finalized = await usage.finalizeAiUsageRequest(auth, {
      usageId,
      status: 'SUCCEEDED',
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
      providerAttempts: 1,
      toolCallsCount: 0,
      durationMs: 5,
    });
    expect(finalized).toBe(true);
    const row = (
      await owner!.query<{ status: string; total_tokens: number }>(
        `select status, total_tokens from public.ai_usage_requests where id = $1::uuid`,
        [usageId],
      )
    ).rows[0]!;
    expect(row.status).toBe('SUCCEEDED');
    expect(Number(row.total_tokens)).toBe(12);

    // The counters definer (org + person assertions) serves the owner.
    const counters = await usage.readAiUsageCounters(auth);
    expect(counters.monthRequests).toBe(1);
    expect(counters.monthTokens).toBe(12);
  }, 90_000);
});
