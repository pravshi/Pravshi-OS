/**
 * Password-reset content confidentiality (migration 0069). LIVE DB.
 *
 * THE VULNERABILITY. The reset email — whose link carries the plaintext reset
 * token — travelled as an `email` job's payload. Anyone holding `jobs.view`
 * could list it: GET /api/jobs returns payloads, and `jobs.view` is held by
 * SUPER_ADMIN, ADMIN and PROJECT_MANAGER (the jobs_select policy checks the
 * permission, not its scope). Since anyone can request a reset for any address
 * before signing in, a PROJECT_MANAGER could request one for a colleague and
 * read the link before the colleague did.
 *
 * THE FIX. The email body lives in public.job_email_content, a table no
 * application role can read (no privileges, FORCE RLS, no app_user policy);
 * the job payload keeps only the recipient, the subject and a content
 * reference. The worker reads the body through job_email_content_for_worker(),
 * which serves only the job it holds (running, claimed by that worker id) and
 * refuses any signed-in caller. The body is deleted once the job is terminal.
 *
 * This suite replays the demonstrated attack end to end — through the real
 * routes and through every database operation the attacker's identity permits —
 * and proves the legitimate path still delivers a working, single-use link.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const resendMocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendMocks.send };
  },
}));

import { env } from '@/env';
import { mkAccount, mkDept, mkOrg, signIn, type Account } from '../authz/fixtures';
import { requestPasswordReset, resetPassword } from '@/lib/auth/password-reset';
import { handleEmail } from '@/lib/jobs/handlers';
import { buildJobAuthorization } from '@/lib/jobs/worker';
import { classifyError } from '@/lib/jobs/retry';
import type { Job } from '@/lib/jobs/types';
import { GET as listJobsRoute } from '@/app/api/jobs/route';
import { GET as getJobRoute } from '@/app/api/jobs/[id]/route';
import { POST as retryJobRoute } from '@/app/api/jobs/[id]/retry/route';
import { POST as cancelJobRoute } from '@/app/api/jobs/[id]/cancel/route';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const RUN = Math.random().toString(36).slice(2, 8);
const LINK = /reset-password\?token=([0-9a-f]{64})/;
const NEW_PASSWORD = 'a fresh and sufficiently long passphrase 7';

describe.skipIf(!HAS_DB)('password-reset content confidentiality (0069, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  let org = '';
  let victim!: Account;
  let pm!: Account;
  let admin!: Account;
  let superAdmin!: Account;
  let ipSeq = 0;
  const nextIp = () => `10.69.${Math.floor(Math.random() * 200)}.${(ipSeq += 1)}`;

  // Everything the application writes to its logs during this suite.
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }),
  );

  beforeAll(async () => {
    if (!HAS_DB) return;
    org = await mkOrg(owner, `pwrc-${RUN}`);
    const dept = await mkDept(owner, org, `PWRC${RUN.toUpperCase()}`);
    [victim, pm, admin, superAdmin] = await Promise.all([
      mkAccount(owner, { org, dept, run: RUN, label: 'pwrc-victim', roles: ['EMPLOYEE'] }),
      mkAccount(owner, {
        org,
        dept,
        run: RUN,
        label: 'pwrc-pm',
        roles: ['PROJECT_MANAGER'],
        mfa: true,
      }),
      mkAccount(owner, { org, dept, run: RUN, label: 'pwrc-admin', roles: ['ADMIN'], mfa: true }),
      mkAccount(owner, {
        org,
        dept,
        run: RUN,
        label: 'pwrc-sa',
        roles: ['SUPER_ADMIN'],
        mfa: true,
      }),
    ]);
  }, 120_000);

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await owner.end();
    await asUser.end();
  });

  /** Request a reset for the victim through the real pre-auth entry; return its job. */
  async function requestResetJob() {
    await requestPasswordReset(victim.email, nextIp());
    const reset = (
      await owner.query<{ id: string }>(
        `select id from auth.password_resets
          where auth_user_id = $1::uuid and used_at is null
          order by created_at desc limit 1`,
        [victim.authUserId],
      )
    ).rows[0]!;
    const job = (
      await owner.query<{ id: string; payload: Record<string, unknown> }>(
        `select id, payload from public.jobs where dedup_key = $1`,
        [`pwreset:${reset.id}`],
      )
    ).rows[0]!;
    return { resetId: reset.id, jobId: job.id, payload: job.payload };
  }

  /** The token, read where only the database owner can read it. */
  async function protectedToken(jobId: string): Promise<string> {
    const row = (
      await owner.query<{ html: string | null }>(
        `select html from public.job_email_content where job_id = $1`,
        [jobId],
      )
    ).rows[0];
    const token = LINK.exec(row?.html ?? '')?.[1];
    if (!token) throw new Error('no protected reset content for the job');
    return token;
  }

  const leaks = (text: string, token: string) =>
    text.includes(token) || /reset-password\?token=/.test(text);

  const call = <P extends Record<string, string>>(
    handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
    account: Account,
    url: string,
    method = 'GET',
    params: P = {} as P,
  ) =>
    handler(new Request(url, { method, headers: new Headers({ cookie: account.cookie }) }), {
      params: Promise.resolve(params),
    });

  async function inCtx<T extends Record<string, unknown>>(
    account: Account,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const c = await asUser.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true),
                set_config('app.aal','aal2',true)`,
        [account.personId, org],
      );
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ALLOWED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERROR';
    }
  };

  async function loadJob(jobId: string): Promise<Job> {
    const r = (
      await owner.query<Record<string, unknown>>(`select * from public.jobs where id = $1`, [jobId])
    ).rows[0]!;
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      type: 'email',
      status: String(r.status) as Job['status'],
      priority: Number(r.priority),
      payload: r.payload as Record<string, unknown>,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      nextRunAt: new Date(String(r.next_run_at)).toISOString(),
      claimedBy: (r.claimed_by as string | null) ?? null,
      claimedAt: null,
      heartbeatAt: null,
      dedupKey: (r.dedup_key as string | null) ?? null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(String(r.created_at)).toISOString(),
      updatedAt: new Date(String(r.updated_at)).toISOString(),
    };
  }

  /** Put the job in the state a worker's claim + start leaves it in. */
  const holdAsWorker = (jobId: string, workerId: string) =>
    owner.query(
      `update public.jobs set status = 'running', claimed_by = $2, claimed_at = now(),
              heartbeat_at = now(), updated_at = now() where id = $1`,
      [jobId, workerId],
    );

  it('queues the reset email without its link: the payload holds only recipient, subject and a reference', async () => {
    const { jobId, payload } = await requestResetJob();
    expect(payload).toMatchObject({ to: victim.email, contentRef: 'job_email_content' });
    expect(payload).not.toHaveProperty('html');
    expect(payload).not.toHaveProperty('text');
    expect(JSON.stringify(payload)).not.toMatch(/token/i);
    // The link exists — in the protected table only.
    expect(await protectedToken(jobId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['PROJECT_MANAGER (department jobs.view)', () => pm],
    ['ADMIN', () => admin],
    ['SUPER_ADMIN', () => superAdmin],
  ])('%s cannot obtain the link through the jobs API', async (_label, who) => {
    const { jobId } = await requestResetJob();
    const token = await protectedToken(jobId);
    const account = who();

    const list = await call(
      listJobsRoute,
      account,
      'http://localhost:3000/api/jobs?type=email&limit=100',
    );
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText, 'the job itself is listed (the attacker can see it exists)').toContain(jobId);
    expect(leaks(listText, token)).toBe(false);

    const detail = await call(
      getJobRoute,
      account,
      `http://localhost:3000/api/jobs/${jobId}`,
      'GET',
      {
        id: jobId,
      },
    );
    expect(detail.status).toBe(200);
    expect(leaks(await detail.text(), token)).toBe(false);
  });

  it.each([
    ['PROJECT_MANAGER', () => pm],
    ['ADMIN', () => admin],
    ['SUPER_ADMIN', () => superAdmin],
  ])(
    '%s cannot obtain the link through any database operation its identity permits',
    async (_label, who) => {
      const { jobId } = await requestResetJob();
      const token = await protectedToken(jobId);
      const account = who();

      // The rows the jobs API reads, read directly under the same identity.
      const rows = await inCtx<{ payload: unknown }>(
        account,
        `select payload from public.jobs where id = $1`,
        [jobId],
      );
      expect(rows).toHaveLength(1);
      expect(leaks(JSON.stringify(rows), token)).toBe(false);

      // The protected table: no privilege at all.
      expect(await codeOf(inCtx(account, `select * from public.job_email_content`))).toBe('42501');
      // The worker's reader: refuses a signed-in caller, whatever worker id it names.
      expect(
        await codeOf(
          inCtx(
            account,
            `select * from public.job_email_content_for_worker($1::uuid, 'any-worker')`,
            [jobId],
          ),
        ),
      ).toBe('42501');
      // And it cannot become the worker: claiming refuses a person context (0068).
      expect(
        await codeOf(inCtx(account, `select id from public.jobs_claim_next('w', array['email'])`)),
      ).toBe('42501');
    },
  );

  it('serves the content only to the worker holding the running job', async () => {
    const { jobId } = await requestResetJob();
    const read = (workerId: string) =>
      asUser.query(`select html from public.job_email_content_for_worker($1::uuid, $2)`, [
        jobId,
        workerId,
      ]);
    // Not claimed yet: refused.
    expect(await codeOf(read('w-owner'))).toBe('42501');
    await holdAsWorker(jobId, `w-owner-${RUN}`);
    // Another worker id: refused.
    expect(await codeOf(read(`w-other-${RUN}`))).toBe('42501');
    // The holder: served.
    const served = await read(`w-owner-${RUN}`);
    expect(LINK.test(String(served.rows[0]?.html))).toBe(true);
  });

  it('a failed send, its job error, the retry and the logs carry no part of the link', async () => {
    const { jobId } = await requestResetJob();
    const token = await protectedToken(jobId);
    const workerId = `w-fail-${RUN}`;
    await holdAsWorker(jobId, workerId);
    const job = await loadJob(jobId);

    // No provider configured: the send fails closed (CONFIG_ERROR).
    const prev = [env.EMAIL_PROVIDER, env.EMAIL_PROVIDER_API_KEY, env.RESEND_API_KEY];
    env.EMAIL_PROVIDER = undefined;
    env.EMAIL_PROVIDER_API_KEY = undefined;
    env.RESEND_API_KEY = undefined;
    let failure: unknown = null;
    try {
      await handleEmail({
        job,
        auth: buildJobAuthorization(job),
        signal: new AbortController().signal,
        workerId,
      });
    } catch (e) {
      failure = e;
    } finally {
      [env.EMAIL_PROVIDER, env.EMAIL_PROVIDER_API_KEY, env.RESEND_API_KEY] = prev;
    }
    expect(failure).not.toBeNull();
    const classified = classifyError(failure);
    expect(leaks(`${classified.code} ${classified.message}`, token)).toBe(false);

    // The worker records the failure exactly as the runtime does.
    await asUser.query(`select * from public.jobs_fail($1, $2::uuid, $3, $4, true)`, [
      workerId,
      jobId,
      classified.code,
      classified.message,
    ]);
    const stored = (
      await owner.query<{ status: string; error_message: string | null }>(
        `select status, error_message from public.jobs where id = $1`,
        [jobId],
      )
    ).rows[0]!;
    expect(leaks(String(stored.error_message), token)).toBe(false);

    // An administrator inspects and retries it: neither answer carries the link.
    const detail = await call(
      getJobRoute,
      admin,
      `http://localhost:3000/api/jobs/${jobId}`,
      'GET',
      { id: jobId },
    );
    expect(leaks(await detail.text(), token)).toBe(false);
    if (stored.status !== 'pending') {
      const retried = await call(
        retryJobRoute,
        admin,
        `http://localhost:3000/api/jobs/${jobId}/retry`,
        'POST',
        {
          id: jobId,
        },
      );
      expect(retried.status).toBeLessThan(500);
      expect(leaks(await retried.text(), token)).toBe(false);
    }
    // A retryable failure keeps the content for the next attempt.
    expect(await protectedToken(jobId)).toBe(token);
  });

  it('cancelling or dead-lettering forgets the body; a reaped claim keeps it; a late retry fails closed', async () => {
    const hasBody = async (jobId: string) =>
      (await owner.query(`select 1 from public.job_email_content where job_id = $1`, [jobId]))
        .rowCount === 1;

    // Cancelled through the real route: the body goes with it, and the answer carries nothing.
    const cancelled = await requestResetJob();
    const cancelledToken = await protectedToken(cancelled.jobId);
    const cancelRes = await call(
      cancelJobRoute,
      admin,
      `http://localhost:3000/api/jobs/${cancelled.jobId}/cancel`,
      'POST',
      { id: cancelled.jobId },
    );
    expect(cancelRes.status).toBeLessThan(300);
    expect(leaks(await cancelRes.text(), cancelledToken)).toBe(false);
    expect(await hasBody(cancelled.jobId)).toBe(false);

    // A claim the reaper hands back (running → pending) keeps the body for the next worker.
    const reaped = await requestResetJob();
    await holdAsWorker(reaped.jobId, `w-dead-${RUN}`);
    await owner.query(
      `update public.jobs set status = 'pending', claimed_by = null, claimed_at = null,
              heartbeat_at = null, updated_at = now() where id = $1`,
      [reaped.jobId],
    );
    expect(await hasBody(reaped.jobId)).toBe(true);

    // Dead-lettered (a non-retryable failure): the body is gone.
    const dead = await requestResetJob();
    const deadToken = await protectedToken(dead.jobId);
    const workerId = `w-dl-${RUN}`;
    await holdAsWorker(dead.jobId, workerId);
    await asUser.query(`select * from public.jobs_fail($1, $2::uuid, 'CONFIG_ERROR', 'x', false)`, [
      workerId,
      dead.jobId,
    ]);
    const deadStatus = (
      await owner.query<{ status: string }>(`select status from public.jobs where id = $1`, [
        dead.jobId,
      ])
    ).rows[0]!.status;
    expect(deadStatus).toBe('dead_letter');
    expect(await hasBody(dead.jobId)).toBe(false);

    // An administrator retries it anyway: the worker finds no body and fails the job
    // without retry, naming no part of the link.
    const retried = await call(
      retryJobRoute,
      admin,
      `http://localhost:3000/api/jobs/${dead.jobId}/retry`,
      'POST',
      { id: dead.jobId },
    );
    expect(retried.status).toBeLessThan(300);
    await holdAsWorker(dead.jobId, workerId);
    let failure: unknown = null;
    try {
      const job = await loadJob(dead.jobId);
      await handleEmail({
        job,
        auth: buildJobAuthorization(job),
        signal: new AbortController().signal,
        workerId,
      });
    } catch (e) {
      failure = e;
    }
    const classified = classifyError(failure);
    expect(classified.retryable).toBe(false);
    expect(classified.message).toMatch(/no longer available/);
    expect(leaks(`${classified.code} ${classified.message}`, deadToken)).toBe(false);
  });

  it('delivers a working, single-use link to the intended recipient, then forgets it', async () => {
    const { jobId } = await requestResetJob();
    const workerId = `w-ok-${RUN}`;
    await holdAsWorker(jobId, workerId);
    const job = await loadJob(jobId);

    const prev = [env.EMAIL_PROVIDER, env.EMAIL_PROVIDER_API_KEY, env.EMAIL_FROM];
    env.EMAIL_PROVIDER = 'resend';
    env.EMAIL_PROVIDER_API_KEY = 'test-api-key';
    env.EMAIL_FROM = 'no-reply@example.com';
    resendMocks.send.mockReset();
    resendMocks.send.mockResolvedValue({ data: { id: `msg-${RUN}` }, error: null });
    try {
      await handleEmail({
        job,
        auth: buildJobAuthorization(job),
        signal: new AbortController().signal,
        workerId,
      });
    } finally {
      [env.EMAIL_PROVIDER, env.EMAIL_PROVIDER_API_KEY, env.EMAIL_FROM] = prev;
    }
    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    const sent = resendMocks.send.mock.calls[0]![0] as {
      to: string[];
      html?: string;
      subject: string;
    };
    expect(sent.to).toEqual([victim.email]);
    const token = LINK.exec(sent.html ?? '')?.[1];
    expect(token, 'the delivered email carries the link').toMatch(/^[0-9a-f]{64}$/);

    // The job completes; its protected content is gone with it.
    await asUser.query(`select * from public.jobs_complete($1, $2::uuid)`, [workerId, jobId]);
    const left = await owner.query(`select 1 from public.job_email_content where job_id = $1`, [
      jobId,
    ]);
    expect(left.rowCount).toBe(0);

    // The recipient uses the link: it works once, and only once.
    expect(await resetPassword(token!, NEW_PASSWORD, nextIp())).toEqual({ ok: true });
    await expect(resetPassword(token!, `${NEW_PASSWORD} again`, nextIp())).rejects.toBeTruthy();
    await expect(signIn(victim.email, NEW_PASSWORD)).resolves.toBeTruthy();
  }, 60_000);

  it('no audit entry, login event or log line of this suite carries a link or token', async () => {
    const audit = await owner.query<{ n: string }>(
      `select count(*) n from public.audit_logs
        where org_id = $1
          and (coalesce(before::text,'') || coalesce(after::text,'') || coalesce(metadata::text,''))
              ~ 'reset-password\\?token='`,
      [org],
    );
    expect(Number(audit.rows[0]!.n)).toBe(0);
    const events = await owner.query<{ n: string }>(
      `select count(*) n from public.login_events
        where email = $1 and coalesce(metadata::text,'') ~ 'token'`,
      [victim.email],
    );
    expect(Number(events.rows[0]!.n)).toBe(0);
    expect(logged.filter((l) => /reset-password\?token=/.test(l))).toEqual([]);
  });
});
