#!/usr/bin/env node
// PRAVSHI OS — secret-shape guard (Task 11).
//
// GitHub Free gives this repository no secret scanning and no push protection, so a
// credential committed by accident would reach the default branch unchallenged. This
// guard is the compensating control: it fails CI when a credential-shaped string
// appears in tracked content.
//
// It reports FILE and LINE only. It never prints the matched value — a guard that
// echoes the secret it caught has published it into the build log.
//
// Usage: node scripts/guards/secret-scan.mjs [--diff <base>]

import { execFileSync } from 'node:child_process';

const PATTERNS = [
  // `$`, `{` and `}` are excluded so a template literal that BUILDS a URL
  // (scripts/ci/provision-branch-role.mjs) is not mistaken for one that contains a
  // credential. A real leaked URL has literal characters in those positions.
  [
    /postgres(?:ql)?:\/\/[^\s:'"`${}]+:[^\s@'"`${}]+@/i,
    'postgres connection string with credentials',
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained PAT'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub classic PAT'],
  [/\bnapi_[A-Za-z0-9]{20,}/, 'Neon API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'private key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI-style secret key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
];

// Values that are published examples or deliberate test fixtures. Each needs a reason:
// a blanket ignore list is how a real secret eventually gets waved through.
const ALLOW = [
  // AWS's own documentation example. GitHub and every scanner treat it as non-secret.
  /AKIAIOSFODNN7EXAMPLE/,
  // The plan's and tests' fake DSN: user "u", password "p", host "ep-x".
  /postgres(?:ql)?:\/\/u:p@ep-x/,
];

const SKIP_FILES = [
  /^pnpm-lock\.yaml$/,
  /^\.gitattributes$/,
  /^scripts\/guards\/secret-scan\.mjs$/,
];

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const base = process.argv.includes('--diff')
  ? process.argv[process.argv.indexOf('--diff') + 1]
  : null;

const files = (
  base ? git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]) : git(['ls-files'])
)
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !SKIP_FILES.some((re) => re.test(f)));

let findings = 0;
for (const file of files) {
  let content;
  try {
    content = git(['show', `HEAD:${file}`]);
  } catch {
    continue; // deleted, or not in HEAD
  }
  if (content.includes('\u0000')) continue; // binary
  content.split('\n').forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    for (const [re, label] of PATTERNS) {
      if (re.test(line)) {
        console.error(`  ${file}:${i + 1}  possible ${label}`);
        findings++;
        break;
      }
    }
  });
}

if (findings > 0) {
  console.error(
    `\nsecret-scan: ${findings} credential-shaped string(s) found. ` +
      'Values are not printed. Remove the credential and rotate it before merging.',
  );
  process.exit(1);
}
console.log(`secret-scan: clean (${files.length} files checked)`);
