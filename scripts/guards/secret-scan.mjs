#!/usr/bin/env node
// PRAVSHI OS — secret-shape guard (Task 11).
//
// GitHub Free gives this repository no secret scanning and no push protection, so a
// credential committed by accident would reach the default branch unchallenged. This
// guard is the compensating control.
//
// WHAT THIS GUARANTEES, EXACTLY:
//
//   --diff <base>   Every line ADDED by any commit in <base>..HEAD is scanned, commit
//                   by commit. The guarantee is "no commit in this change introduces a
//                   credential" — deliberately stronger than scanning the net diff,
//                   because a secret added in one commit and removed in the next is
//                   still published in the pushed history.
//   (no --diff)     Every tracked file at HEAD is scanned.
//
// This is NOT full-history forensics: it does not scan commits outside the given range,
// unreachable objects, or packfiles. Use a dedicated history scanner for that.
//
// It reports FILE and LINE only, never the matched value — a guard that echoes the
// secret it caught has published it into the build log.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Each pattern is global so every candidate on a line is tested independently.
const PATTERNS = [
  [
    // `$`, `{`, `}` excluded so a template literal that BUILDS a URL is not mistaken
    // for one that contains a credential. A leaked URL has literal characters there.
    /postgres(?:ql)?:\/\/[^\s:'"`${}]+:[^\s@'"`${}]+@[^\s'"`]+/gi,
    'postgres connection string with credentials',
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained PAT'],
  [/\bghp_[A-Za-z0-9]{30,}/g, 'GitHub classic PAT'],
  [/\bnapi_[A-Za-z0-9]{20,}/g, 'Neon API key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, 'private key'],
  [/\bsk-[A-Za-z0-9]{20,}/g, 'OpenAI-style secret key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
];

// Allowed TOKENS, not allowed lines. Finding #1: a line-level allowlist let an approved
// placeholder shield a real credential sharing the same line. Each entry must match the
// candidate token in full, and each needs a reason.
const ALLOWED_TOKENS = [
  // AWS's own published documentation example; every scanner treats it as non-secret.
  /^AKIAIOSFODNN7EXAMPLE$/,
  // The plan's and tests' fake DSN: user "u", password "p", host "ep-x".
  /^postgres(?:ql)?:\/\/u:p@ep-x[^\s]*$/i,
];

const SKIP_FILES = [/^pnpm-lock\.yaml$/];

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Returns [{ label }] for every candidate token on the line that is not allow-listed. */
export function findSecrets(line) {
  const hits = [];
  for (const [re, label] of PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const token = m[0];
      if (ALLOWED_TOKENS.some((a) => a.test(token))) continue;
      hits.push({ label });
    }
  }
  return hits;
}

/** Added lines per commit, so an intermediate commit cannot hide a credential. */
function addedLinesInRange(base) {
  const shas = git(['rev-list', '--reverse', `${base}..HEAD`])
    .split('\n')
    .filter(Boolean);
  const out = [];
  for (const sha of shas) {
    // --unified=0 keeps context lines out; only genuinely added lines are considered.
    const diff = git(['show', '--format=', '--unified=0', '--no-color', sha]);
    let file = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('+++ ')) file = null;
      else if (line.startsWith('+') && !line.startsWith('+++') && file) {
        out.push({ file, sha: sha.slice(0, 7), text: line.slice(1) });
      }
    }
  }
  return out;
}

function scanHead() {
  const files = git(['ls-files'])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !SKIP_FILES.some((re) => re.test(f)));
  const out = [];
  for (const file of files) {
    let content;
    try {
      content = git(['show', `HEAD:${file}`]);
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue; // binary
    content.split('\n').forEach((text, i) => out.push({ file, line: i + 1, text }));
  }
  return { units: out, count: files.length };
}

function main() {
  const i = process.argv.indexOf('--diff');
  const base = i !== -1 ? process.argv[i + 1] : null;

  let units;
  let scope;
  if (base) {
    units = addedLinesInRange(base).filter((u) => !SKIP_FILES.some((re) => re.test(u.file)));
    scope = `lines added by each commit in ${base}..HEAD`;
  } else {
    const head = scanHead();
    units = head.units;
    scope = `${head.count} tracked files at HEAD`;
  }

  let findings = 0;
  for (const u of units) {
    for (const hit of findSecrets(u.text)) {
      const where = u.sha ? `${u.file} (added in ${u.sha})` : `${u.file}:${u.line}`;
      console.error(`  ${where}  possible ${hit.label}`);
      findings++;
    }
  }

  if (findings > 0) {
    console.error(
      `\nsecret-scan: ${findings} credential-shaped string(s) found. Values are not printed. ` +
        'Remove the credential and rotate it before merging.',
    );
    process.exit(1);
  }
  console.log(`secret-scan: clean (${scope})`);
}

// Importable for tests; only scans when run directly.

// Importable for tests; only scans when executed directly.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) main();
