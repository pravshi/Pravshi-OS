#!/usr/bin/env node
// PRAVSHI OS — direct-push audit decision logic.
//
// DETECTION, NOT PREVENTION. Nothing prevents a push to main: when last checked
// (2026-10-15) no branch protection or ruleset was configured on it, and on GitHub Free a
// private repository cannot have one. This decides, after the fact, whether a pushed commit
// reached main in one of the two permitted ways, and fails the workflow run if it did not.
// It changes no repository state, opens no issue, and needs only read permissions.
//
// Permitted ways (founder milestone workflow, 2026-10-30):
//   1. A merged pull request (decided from GitHub's PR-association data, never from the
//      commit subject — a subject ending "(#123)" is trivially forged; finding #3).
//   2. A direct milestone push, and ONLY when every one of these holds, each decided from
//      GitHub data and none from who pushed or what the message says:
//        a. it is not a force push and `before` is an ancestor of the new tip (a plain
//           fast-forward — no rewritten or dropped history);
//        b. the range is small enough to audit completely (GitHub truncates large ranges;
//           an incomplete audit fails closed);
//        c. no commit asks CI to be skipped ("[skip ci]" and friends);
//        d. the range touches none of the PROTECTED_PATHS — the controls that decide what is
//           trustworthy (CI, guards, migrations, roles). Changing those needs a pull request
//           and an independent review;
//        e. the `ci` workflow run for exactly this commit COMPLETED SUCCESSFULLY (or, when a
//           later push cancelled it through the workflow's concurrency group, a later
//           successful run whose tip descends from this commit covers it).
//
// There is deliberately no identity-based bypass: no actor, bot or token is trusted.
//
// KNOWN LIMITS (documented, not hidden). This is DETECTION after the fact, not a safeguard
// against a hostile pusher with write access:
//   - The push is not prevented; the result is a red run. Vercel may deploy main before the
//     audit finishes.
//   - The push-triggered workflow runs the code of the pushed commit. A push that edits or
//     deletes this script or the workflow, changes its `on:`, or deletes ci.yml can make its own
//     audit pass or never run. Rule (d) flags such a range under the honest script; it cannot
//     stop a hostile one. A push made with GITHUB_TOKEN triggers no workflow at all.
//   - A tip commit carrying a skip marker triggers neither `ci` nor this audit: a complete,
//     silent bypass of both. Rule (c) only flags a skip marker on a NON-tip commit of a range,
//     because each range starts at the previous tip and so never re-reads an earlier push.
//   - The audit trusts `event.before` as a known-good base. A push that failed its audit does
//     not poison later pushes: a clean fast-forward after it can be green.
//   - The PR path checks the merge, not review or CI on the PR: a self-merged red PR passes.
//   - Net-diff blindness: a range that adds and then reverts a protected change shows nothing.
//   - The compare API's own limits (100 commits, 300 files per call) are enforced fail-closed.
//   A scheduled sweep from main (or branch protection with a required `ci` check) is the way to
//   close the silent cases; branch protection is a repository setting only the founder can
//   change.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Decide whether `sha` is the merge result, into main, of a merged pull request.
 *
 * @param {string} sha    the pushed commit
 * @param {Array}  pulls  response of GET /repos/{o}/{r}/commits/{sha}/pulls
 * @returns {{ok: boolean, reason: string}}
 */
export function isFromMergedPr(sha, pulls) {
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return { ok: false, reason: 'no pull request is associated with this commit' };
  }
  let merged = false;
  for (const pr of pulls) {
    if (!pr?.merged_at) continue; // open or closed-unmerged proves nothing
    merged = true;
    // A PR merged into some other branch must not vouch for a commit pushed to main, and the
    // pushed commit must be that PR's own merge result (merge, squash or rebase tip).
    if (pr.base?.ref === 'main' && pr.merge_commit_sha === sha) {
      return { ok: true, reason: `merge result of PR #${pr.number} into main` };
    }
  }
  return {
    ok: false,
    reason: merged
      ? "associated merged PR(s) are not this commit's merge into main"
      : 'associated pull request(s) exist but none is merged',
  };
}

/**
 * Paths a direct push may not touch. Prefixes end with "/"; the rest are exact files.
 * These are the controls themselves and what CI executes or trusts, plus the changes the
 * founder routes through a PR (shared files, dependencies, migrations, roles, agent rules).
 * Matching is case-insensitive.
 */
export const PROTECTED_PATHS = [
  // CI, guards and the scripts they and the build run
  '.github/',
  'scripts/',
  'tests/ci/',
  'tests/guards/',
  'tests/setup.ts',
  // what CI executes and trusts: dependencies, lifecycle scripts, runtime and tool configuration
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  'patches/',
  'vitest.config.mts',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.mjs',
  'next.config.ts',
  'playwright.config.ts',
  'vercel.json',
  // the workspace packages (redesign Step 7): their manifests and the web app's tool configuration
  'apps/web/package.json',
  'apps/worker/package.json',
  'apps/web/tsconfig.json',
  'apps/worker/tsconfig.json',
  'apps/web/next.config.ts',
  'apps/web/vercel.json',
  // migrations, roles and the shared security entry points the founder decides
  'drizzle/',
  'apps/web/src/middleware.ts',
  'src/env.ts',
  // the agent rules (AGENTS.md §3: the founder decides)
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/',
  '.agents/',
];

export function isProtectedPath(path) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return PROTECTED_PATHS.some((entry) => {
    const e = entry.toLowerCase();
    return e.endsWith('/') ? p.startsWith(e) : p === e;
  });
}

// GitHub documents these markers; any of them in a commit message suppresses push workflows.
const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;

export function hasSkipCiMarker(message) {
  return SKIP_CI.test(String(message ?? ''));
}

/** One compare call returns at most 100 commits (per_page) and 300 files; beyond that it is partial. */
export const COMPARE_COMMIT_CAP = 100;
export const COMPARE_FILE_CAP = 300;

const ZERO_SHA = /^0{40}$/;

/**
 * The static half of the direct-push verdict (everything except CI).
 *
 * @param {{forced?: boolean, before?: string, compare: object|null}} input  `compare` is the
 *        response of GET /repos/{o}/{r}/compare/{before}...{sha}
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluatePushRange({ forced, before, compare }) {
  if (forced) return { ok: false, reason: 'force push: history was rewritten' };
  if (!before || ZERO_SHA.test(before))
    return { ok: false, reason: 'no previous tip to compare against (new or reset branch)' };
  if (!compare || typeof compare !== 'object')
    return { ok: false, reason: 'the pushed range could not be read' };
  if (compare.status !== 'ahead')
    return {
      ok: false,
      reason: `not a fast-forward of the previous tip (compare status "${compare.status}")`,
    };

  const commits = Array.isArray(compare.commits) ? compare.commits : [];
  const files = Array.isArray(compare.files) ? compare.files : [];
  if (
    commits.length === 0 ||
    compare.total_commits > commits.length ||
    commits.length >= COMPARE_COMMIT_CAP ||
    files.length >= COMPARE_FILE_CAP
  )
    return {
      ok: false,
      reason: 'the range is empty or too large to audit completely; use a pull request',
    };

  if (commits.some((c) => hasSkipCiMarker(c?.commit?.message)))
    return { ok: false, reason: 'a commit in the range asks for CI to be skipped' };

  const touched = files
    .flatMap((f) => [f?.filename, f?.previous_filename])
    .filter((n) => typeof n === 'string' && isProtectedPath(n));
  if (touched.length > 0)
    return {
      ok: false,
      reason: `the range changes protected control files (${[...new Set(touched)].slice(0, 5).join(', ')}); use a pull request`,
    };

  return { ok: true, reason: `fast-forward of ${commits.length} commit(s), no protected paths` };
}

/**
 * The CI half of the verdict.
 *
 * @param {Array<{status: string, conclusion: string|null}>} runsForSha  `ci` workflow runs
 *        whose head_sha is the pushed commit
 * @param {boolean} coveredByLaterSuccess  a later successful `ci` run descends from this commit
 * @returns {{state: 'pass'|'fail'|'wait', reason: string}}
 */
export function evaluateCiRuns(runsForSha, coveredByLaterSuccess = false) {
  const runs = Array.isArray(runsForSha) ? runsForSha : [];
  if (runs.length === 0) return { state: 'wait', reason: 'no ci run for this commit yet' };
  if (runs.some((r) => r.status === 'completed' && r.conclusion === 'success')) {
    const failed = runs.filter((r) => r.status === 'completed' && r.conclusion === 'failure');
    return {
      state: 'pass',
      reason:
        'ci completed successfully for this commit' +
        (failed.length ? ` (after ${failed.length} earlier failed run(s) of the same commit)` : ''),
    };
  }
  if (runs.some((r) => r.status !== 'completed'))
    return { state: 'wait', reason: 'ci is still running for this commit' };
  // Every run is completed and none succeeded.
  if (runs.every((r) => r.conclusion === 'cancelled')) {
    return coveredByLaterSuccess
      ? { state: 'pass', reason: 'ci was superseded; a later successful ci run covers this commit' }
      : { state: 'wait', reason: 'ci was cancelled; waiting for the superseding run' };
  }
  return { state: 'fail', reason: 'ci did not succeed for this commit' };
}

/**
 * Full audit of one pushed commit. All GitHub access goes through `api(path)`, which returns
 * parsed JSON or throws; `sleep` and `now` are injectable so the polling is testable.
 */
export async function auditCommit({ api, sha, before, forced, sleep, now = Date.now, waitMs }) {
  const SHA = /^[0-9a-f]{40}$/;
  if (!SHA.test(String(sha))) throw new Error('COMMIT_SHA is not a 40-character hex SHA');
  if (before && !SHA.test(String(before)))
    throw new Error('BEFORE_SHA is not a 40-character hex SHA');
  const pulls = await api(`/commits/${sha}/pulls`);
  const viaPr = isFromMergedPr(sha, pulls);
  if (viaPr.ok) return { ok: true, path: 'pr', reason: viaPr.reason };

  const compare =
    !before || ZERO_SHA.test(before)
      ? null
      : await api(`/compare/${before}...${sha}?per_page=${COMPARE_COMMIT_CAP}`);
  const range = evaluatePushRange({ forced, before, compare });
  if (!range.ok) return { ok: false, path: 'direct', reason: range.reason };

  const deadline = now() + waitMs;
  for (;;) {
    const body = await api(
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`,
    );
    const runs = (body?.workflow_runs ?? []).filter(
      (r) => r.head_sha === sha && r.head_branch === 'main',
    );
    let covered = false;
    if (
      runs.length > 0 &&
      runs.every((r) => r.status === 'completed' && r.conclusion === 'cancelled')
    ) {
      const later = await api(
        '/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=20',
      );
      for (const r of later?.workflow_runs ?? []) {
        if (r.head_sha === sha) continue;
        const cmp = await api(`/compare/${sha}...${r.head_sha}`);
        if (cmp?.status === 'ahead') {
          covered = true;
          break;
        }
      }
    }
    const ci = evaluateCiRuns(runs, covered);
    if (ci.state === 'pass')
      return { ok: true, path: 'direct', reason: `${range.reason}; ${ci.reason}` };
    if (ci.state === 'fail') return { ok: false, path: 'direct', reason: ci.reason };
    if (now() >= deadline)
      return { ok: false, path: 'direct', reason: `${ci.reason} (gave up waiting)` };
    await sleep(30_000);
  }
}

function makeApi(repo, token) {
  return async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok)
      throw new Error(`GitHub API returned HTTP ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  };
}

async function main() {
  const [sha, repo] = [process.env.COMMIT_SHA, process.env.GITHUB_REPOSITORY];
  const token = process.env.GITHUB_TOKEN;
  if (!sha || !repo || !token)
    throw new Error('COMMIT_SHA, GITHUB_REPOSITORY and GITHUB_TOKEN are required');

  const verdict = await auditCommit({
    api: makeApi(repo, token),
    sha,
    before: process.env.BEFORE_SHA,
    forced: process.env.FORCED === 'true',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    waitMs: Number(process.env.CI_WAIT_MINUTES ?? 40) * 60_000,
  });
  console.log(`commit ${sha.slice(0, 7)} (${verdict.path}): ${verdict.reason}`);
  if (verdict.ok) return;

  const message =
    'Unauthorised or unverifiable push to main detected.\n' +
    `Reason: ${verdict.reason}. A direct push is accepted only as a verified fast-forward milestone with a green ci run and no protected-file changes; otherwise use a pull request.`;
  console.log(`::error title=Push to main failed the audit::${message.replace(/\n/g, ' ')}`);
  console.log(message);
  process.exit(1);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) await main();
