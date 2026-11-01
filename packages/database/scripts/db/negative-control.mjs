#!/usr/bin/env node
// PRAVSHI OS — negative control for prove-rls-assert.sql's ownership assertion (Task 3b, fix
// round 1).
//
// WHY THIS EXISTS. Assertion 6 of prove-rls-assert.sql fails if app_user owns, or holds
// membership in the owner of, any relation — the fix for the finding that Postgres's ownership
// test is role membership with inheritance, not name equality, so a stray
// `grant app_owner to app_user` would silently make app_user the effective owner of every
// app_owner table and exempt it from RLS on anything not marked FORCE. In Phase 0 there are no
// application tables yet, so assertion 6's query (`pg_has_role(current_user, c.relowner,
// 'USAGE')` over pg_class) finds zero relations regardless of what app_user's memberships are.
// The assertion PASSES every run so far — but it has been passing vacuously: nothing has ever
// put it in the state it exists to catch. Without a negative control, the fix is asserted, not
// exercised.
//
// WHAT THIS SCRIPT DOES. It reproduces the exact attack assertion 6 defends against, once,
// against the throwaway probe table prove-rls-setup.sql creates, and confirms the assertion
// actually fires:
//   1. set the probe up (as app_owner)
//   2. baseline — the proof must PASS before anything is broken
//   3. ATTACK — grant app_owner to app_user
//   4. the proof must now FAIL
//   5. revoke the grant, in a `finally` — this runs even if a step above threw. Leaving
//      app_user a member of app_owner is the precise hole this whole phase exists to close; a
//      negative control that can fail unsafely and leave that grant standing would be worse
//      than having no negative control at all.
//   6. the proof must PASS again, confirming the revoke actually restored the clean state
//   7. tear the probe down
//
// WHAT THIS ESTABLISHES. That assertion 6 catches this specific, real scenario —
// membership-derived owner-equivalence via a direct grant to app_user — rather than passing
// vacuously because Phase 0 has no application tables.
//
// WHAT THIS DOES NOT ESTABLISH. This is one run of one attack (a direct
// `grant app_owner to app_user`) against one throwaway probe table on one branch. It says
// nothing about the `set_config` mutation an earlier draft of this project's README claimed had
// been tested — it has not been, by this script or otherwise. Passing once is evidence the
// check works, not a guarantee it always will. Re-run this in Phase 1, once real application
// tables exist, so assertion 6 is exercised against genuine relations instead of only the probe.
//
// Reuses run.mjs's env loading, redaction, and connection config rather than reimplementing
// them (see run.mjs for the secrets and transaction-shape rules this script also follows). Like
// run.mjs, this prints derived facts only — role names and row counts — never a connection
// string, host, user, or password; every write to stdout/stderr is redacted regardless.
//
// PREREQUISITES. roles.sql and the password step must already have been applied to this branch
// (app_owner/app_user/app_admin must exist and their passwords in .env must be current).
//
// CAUTION. For the duration of steps 3-5, app_user really does hold app_owner's privileges on
// whatever branch this is pointed at. Do not run this against a branch anything else is using
// at the same time.
//
// Usage:
//   node scripts/db/negative-control.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadEnv, buildRedactor, installOutputRedaction, clientConfigFor } from './run.mjs';

const SETUP_SQL = fileURLToPath(new URL('./prove-rls-setup.sql', import.meta.url));
const ASSERT_SQL = fileURLToPath(new URL('./prove-rls-assert.sql', import.meta.url));
const TEARDOWN_SQL = fileURLToPath(new URL('./prove-rls-teardown.sql', import.meta.url));

// ----------------------------------------------------------------------- connection helpers

// Opens one client for one role, runs fn, and always closes it — the same one-session-per-use
// shape run.mjs uses, applied here per step instead of per invocation, because each step in
// this sequence needs a different role's credentials.
async function withClient(role, env, fn) {
  const config = clientConfigFor(role, env);
  const client = new pg.Client(config);
  client.on('notice', (n) => console.log(`  NOTICE: ${n.severity}: ${n.message}`));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Same execution shape as run.mjs's runFile(): the file is sent as one simple-query string, no
// parameters, so Postgres runs it as one implicit transaction block and prove-rls-assert.sql's
// own begin;/commit; do what the file says they do.
async function runSqlFile(client, filePath) {
  const sql = readFileSync(filePath, 'utf8');
  await client.query(sql);
}

async function membershipCount(client) {
  const { rows } = await client.query(
    "select count(*)::int as n from pg_auth_members where member = 'app_user'::regrole",
  );
  return rows[0].n;
}

// ------------------------------------------------------------------------------------- steps

async function runAssert(env) {
  try {
    await withClient('app_user', env, (client) => runSqlFile(client, ASSERT_SQL));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}

// Run as `owner`: it created app_owner via roles.sql and was auto-granted ADMIN OPTION on it,
// which is what GRANT/REVOKE ROLE requires on the role being granted or revoked.
async function grantAttack(env) {
  return withClient('owner', env, async (client) => {
    await client.query('grant app_owner to app_user');
    return membershipCount(client);
  });
}

async function revokeAttack(env) {
  return withClient('owner', env, async (client) => {
    await client.query('revoke app_owner from app_user');
    return membershipCount(client);
  });
}

// --------------------------------------------------------------------------------------- main

async function main() {
  const env = loadEnv();
  installOutputRedaction(buildRedactor(env));

  let failed = false;
  const markFailed = (msg) => {
    failed = true;
    console.error(`  FAILED — ${msg}`);
  };

  try {
    console.log('step 1 — set the probe up (as app_owner)');
    await withClient('app_owner', env, (client) => runSqlFile(client, SETUP_SQL));
    console.log('  ok');

    console.log('step 2 — baseline: proof must PASS before breaking anything');
    const baseline = await runAssert(env);
    if (!baseline.ok) {
      throw new Error(
        `baseline failed before any attack was made — aborting without granting anything: ${baseline.message}`,
      );
    }
    console.log('  exit 0  (PASS)');

    try {
      console.log('step 3 — ATTACK: grant app_owner to app_user');
      const grantedCount = await grantAttack(env);
      console.log(`  app_user memberships now: ${grantedCount}`);

      console.log('step 4 — proof must now FAIL');
      const attacked = await runAssert(env);
      if (attacked.ok) {
        markFailed(
          'step 4: proof PASSED while app_user held app_owner membership — assertion 6 did not catch it',
        );
      } else {
        console.log('  exit 1  (FAILED — assertion works)');
        console.log(`        raised: ${attacked.message}`);
      }
    } finally {
      // Always runs, even if the grant or the step-4 check above threw. A revoke failure here
      // is caught rather than left to propagate, so it can never override — and hide — an
      // exception from the block above while still being reported loudly.
      console.log('step 5 — revoke (always runs)');
      try {
        const remaining = await revokeAttack(env);
        console.log(
          `  memberships after revoke: ${remaining} ${remaining === 0 ? '(clean)' : '(NOT CLEAN)'}`,
        );
        if (remaining !== 0) {
          markFailed(
            `step 5: app_user still holds ${remaining} membership(s) after revoke — remove it by hand immediately`,
          );
        }
      } catch (err) {
        markFailed(
          `step 5: revoke itself failed — app_user may still hold app_owner membership: ${err?.message ?? String(err)}`,
        );
      }
    }

    console.log('step 6 — proof must PASS again');
    const restored = await runAssert(env);
    if (!restored.ok) {
      markFailed(`step 6: proof did not pass again after revoke: ${restored.message}`);
    } else {
      console.log('  exit 0  (PASS — restored)');
    }
  } finally {
    console.log('step 7 — probe torn down');
    try {
      await withClient('app_owner', env, (client) => runSqlFile(client, TEARDOWN_SQL));
      console.log('  ok');
    } catch (err) {
      markFailed(
        `step 7: teardown failed — the probe table may still exist: ${err?.message ?? String(err)}`,
      );
    }
  }

  if (failed) {
    throw new Error('negative control FAILED — see FAILED lines above');
  }
  console.log(
    'negative control PASSED — assertion 6 catches membership-derived owner-equivalence (grant app_owner to app_user)',
  );
}

function reportAndExit(error) {
  console.error('FAILED');
  console.error(`  ${error?.message ?? String(error)}`);
  if (error?.stack) console.error(String(error.stack));
  process.exit(1);
}

// Only when run as a script, same guard as run.mjs — importing this file must not open a
// connection, and importing run.mjs from here must not run run.mjs's own main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('uncaughtException', reportAndExit);
  process.on('unhandledRejection', reportAndExit);
  await main().catch(reportAndExit);
}
