/**
 * Give another worktree of this repository the agent rules, as checksum-verified copies.
 *
 * The rule files (AGENTS.md, CLAUDE.md, .claude/, .agents/) are tracked on `main` since PR #100,
 * so a worktree created from the current `origin/main` already has them and this script refuses
 * it. A worktree created BEFORE that has none; this copies the COMMITTED rule files from the
 * primary worktree (the one this script sits in) into such a worktree, where both agents load
 * them natively. The copies are untracked and excluded from Git by .git/info/exclude, so they
 * cannot be staged, committed or pushed by accident.
 *
 *   node scripts/agents/sync-worktree-rules.mjs <worktree>          copy, then verify
 *   node scripts/agents/sync-worktree-rules.mjs <worktree> --check  verify only; writes nothing
 *
 * Safeguards — any of these refuses the whole run before anything is written:
 *   - the target is not a registered worktree of this repository, or is the primary itself;
 *   - the primary's rule files have uncommitted changes (only committed rules are copied);
 *   - the target's branch tracks a rule file of its own;
 *   - a target path would not be ignored by Git;
 *   - a target path, or a folder on its way, is a link or junction, or not a regular file;
 *   - a copy differs from what this script last wrote there (someone edited it).
 * It never deletes a file, and the only Git commands it runs are read-only. The checksums of the
 * last sync are kept in the target's own Git directory (.git/worktrees/<name>/), never in its
 * working tree.
 *
 * Exit codes: 0 in sync · 1 --check found missing or stale copies · 2 usage · 3 refused.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The allowlist: these two files, and Markdown files directly inside these three folders.
const ALLOWED =
  /^(AGENTS\.md|CLAUDE\.md|\.claude\/(rules|agents)\/[^/]+\.md|\.agents\/rules\/[^/]+\.md)$/;
const ROOTS = ['AGENTS.md', 'CLAUDE.md', '.claude/rules', '.claude/agents', '.agents/rules'];
const MANIFEST = 'pravshi-rules-sync.json';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => {
  const n = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const refusals = [];
const refuse = (msg) => refusals.push(msg);
const stopIfRefused = () => {
  if (!refusals.length) return;
  for (const r of refusals) console.error(`REFUSED: ${r}`);
  console.error('Nothing was written.');
  process.exit(3);
};

const args = process.argv.slice(2);
const check = args.includes('--check');
const targets = args.filter((a) => a !== '--check');
if (targets.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--check')) {
  console.error('usage: node scripts/agents/sync-worktree-rules.mjs <worktree> [--check]');
  process.exit(2);
}
if (!fs.existsSync(targets[0])) {
  console.error(`REFUSED: ${targets[0]} does not exist`);
  process.exit(3);
}
const target = fs.realpathSync.native(targets[0]);
const source = fs.realpathSync.native(SOURCE);

// ── The source must be the primary worktree, with its rule files committed ────────────────
const [srcGitDir, srcCommon] = git(source, [
  'rev-parse',
  '--path-format=absolute',
  '--git-dir',
  '--git-common-dir',
])
  .trim()
  .split('\n');
if (!same(srcGitDir, srcCommon))
  refuse(`${source} is not the primary worktree; run the copy of this script that is in it`);
const files = git(source, ['ls-files', '-z', '--', ...ROOTS])
  .split('\0')
  .filter((f) => ALLOWED.test(f))
  .sort();
if (!files.includes('AGENTS.md') || !files.includes('CLAUDE.md'))
  refuse('AGENTS.md and CLAUDE.md must both be committed in the primary worktree');
const dirty = git(source, ['status', '--porcelain', '--', ...files]).trim();
if (dirty)
  refuse(
    `the primary worktree's rule files have uncommitted changes — commit or revert them first:\n${dirty}`,
  );
stopIfRefused();

// ── The target must be another registered worktree of this same repository, at its root ──
if (same(target, source)) refuse('the target is the primary worktree itself');
const registered = git(source, ['worktree', 'list', '--porcelain'])
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length));
if (!registered.some((w) => same(w, target)))
  refuse(`${target} is not a registered worktree of this repository`);
stopIfRefused();
const [top, tgtGitDir, tgtCommon] = git(target, [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-dir',
  '--git-common-dir',
])
  .trim()
  .split('\n');
if (!same(top, target)) refuse(`${target} is not the root of its worktree (${top} is)`);
if (!same(tgtCommon, srcCommon)) refuse('the target belongs to a different repository');
stopIfRefused();

// ── Per-file safety checks; nothing is written until every file passes ───────────────────
const trackedInTarget = git(target, ['ls-files', '-z', '--', ...files])
  .split('\0')
  .filter(Boolean);
for (const f of trackedInTarget)
  refuse(`${f} is tracked on the target's branch — it has its own rule files; not overwriting`);
let ignored = [];
try {
  ignored = execFileSync('git', ['-C', target, 'check-ignore', '--stdin', '-z'], {
    input: files.join('\0'),
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
} catch (e) {
  if (e.status !== 1) throw e; // 1 = none of the paths is ignored
}
for (const f of files.filter((f) => !ignored.includes(f)))
  refuse(
    `${f} would not be ignored by Git in the target — add the rule paths to .git/info/exclude first`,
  );

const manifestPath = path.join(tgtGitDir, MANIFEST);
const last = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files
  : {};
const plan = [];
for (const f of files) {
  const segments = f.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const p = path.join(target, ...segments.slice(0, i));
    if (!fs.existsSync(p)) break;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) refuse(`${p} is a link or junction`);
    else if (i === segments.length && !st.isFile()) refuse(`${p} exists and is not a regular file`);
  }
  const want = sha256(path.join(source, f));
  const dst = path.join(target, f);
  if (!fs.existsSync(dst)) plan.push({ f, want, state: 'missing' });
  else {
    const have = fs.lstatSync(dst).isFile() ? sha256(dst) : null;
    if (have === want) plan.push({ f, want, state: 'ok' });
    else if (have && last[f] === have) plan.push({ f, want, state: 'stale' });
    else if (have)
      refuse(
        `${f} in the target was edited after its last sync (or was not written by this script)`,
      );
  }
}
stopIfRefused();

// Files in the copied folders that the primary no longer has: reported, never deleted.
const extra = [];
for (const dir of ['.claude/rules', '.claude/agents', '.agents/rules']) {
  const d = path.join(target, dir);
  if (!fs.existsSync(d)) continue;
  for (const name of fs.readdirSync(d))
    if (!files.includes(`${dir}/${name}`)) extra.push(`${dir}/${name}`);
}

const head = git(source, ['rev-parse', '--short', 'HEAD']).trim();
console.log(`source: ${source} @ ${head} (${files.length} rule files)`);
console.log(`target: ${target}`);
for (const p of plan) console.log(`  ${p.state.padEnd(7)} ${p.f}`);
for (const x of extra) console.log(`  extra   ${x} (not in the primary; left untouched)`);

if (check) {
  const drift = plan.filter((p) => p.state !== 'ok').length;
  console.log(
    drift ? `CHECK: ${drift} copy(ies) missing or stale — run without --check` : 'CHECK: in sync',
  );
  process.exit(drift ? 1 : 0);
}

// ── Copy, then prove it ──────────────────────────────────────────────────────────────────
const statusBefore = git(target, ['status', '--porcelain', '-z', '--untracked-files=all']);
for (const p of plan.filter((p) => p.state !== 'ok')) {
  fs.mkdirSync(path.dirname(path.join(target, p.f)), { recursive: true });
  fs.copyFileSync(path.join(source, p.f), path.join(target, p.f));
}
const bad = plan.filter((p) => sha256(path.join(target, p.f)) !== p.want).map((p) => p.f);
const statusAfter = git(target, ['status', '--porcelain', '-z', '--untracked-files=all']);
// No checksum record after a failed copy: the next run then refuses instead of trusting it.
if (bad.length) {
  console.error(`FAILED: checksum mismatch after copying: ${bad.join(', ')}`);
  process.exit(3);
}
if (statusAfter !== statusBefore) {
  console.error(
    'FAILED: the copy changed what `git status` shows in the target — check .git/info/exclude',
  );
  process.exit(3);
}
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    { source, sourceHead: head, files: Object.fromEntries(plan.map((p) => [p.f, p.want])) },
    null,
    2,
  ),
);
console.log(
  `SYNCED: ${plan.length} files verified by sha256; the target's git status is unchanged`,
);
