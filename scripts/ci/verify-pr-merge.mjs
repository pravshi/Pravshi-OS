#!/usr/bin/env node
// PRAVSHI OS — direct-push audit decision logic (Task 11, finding #3).
//
// COMPENSATING CONTROL, DETECTION ONLY. GitHub Free cannot prevent a direct push to
// main. This determines, after the fact, whether a pushed commit genuinely arrived
// through a merged pull request, and fails the workflow run if it did not. It changes
// no repository state, opens no issue, and needs only read permissions.
//
// Finding #3: the previous version trusted a commit subject ending "(#123)", which
// anyone can type. Nothing here reads the commit message at all — the decision comes
// from GitHub's own commit/PR association data.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Decide whether `sha` arrived through a merged pull request.
 *
 * @param {string} sha    the pushed commit
 * @param {Array}  pulls  response of GET /repos/{o}/{r}/commits/{sha}/pulls
 * @returns {{ok: boolean, reason: string}}
 */
export function isFromMergedPr(sha, pulls) {
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return { ok: false, reason: 'no pull request is associated with this commit' };
  }
  for (const pr of pulls) {
    if (!pr?.merged_at) continue; // open or closed-unmerged proves nothing
    if (pr.merge_commit_sha === sha) {
      return { ok: true, reason: `merge commit of merged PR #${pr.number}` };
    }
    // Squash and rebase merges: GitHub still associates the resulting commit with the PR.
    return { ok: true, reason: `commit associated with merged PR #${pr.number}` };
  }
  return { ok: false, reason: 'associated pull request(s) exist but none is merged' };
}

async function main() {
  const [sha, repo] = [process.env.COMMIT_SHA, process.env.GITHUB_REPOSITORY];
  const token = process.env.GITHUB_TOKEN;
  if (!sha || !repo || !token)
    throw new Error('COMMIT_SHA, GITHUB_REPOSITORY and GITHUB_TOKEN are required');

  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status} for commit/pulls`);
  const pulls = await res.json();

  const verdict = isFromMergedPr(sha, pulls);
  console.log(`commit ${sha.slice(0, 7)}: ${verdict.reason}`);
  if (verdict.ok) return;

  const message =
    'Unexpected direct push to main detected.\n' +
    'Policy violation: production changes must arrive through a PR.';
  console.log(`::error title=Direct push to main::${message.replace(/\n/g, ' ')}`);
  console.log(message);
  process.exit(1);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) await main();
