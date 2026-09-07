import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCANNER = resolve('scripts/guards/secret-scan.mjs');
const REAL_PAT = 'github_pat_' + 'B'.repeat(24);

let repo: string | null = null;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = null;
});

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.test');
  g('config', 'user.name', 'test');
  writeFileSync(join(dir, 'seed.txt'), 'nothing here\n');
  g('add', '.');
  g('commit', '-qm', 'seed');
  return dir;
}

function commit(dir: string, file: string, body: string, msg: string) {
  writeFileSync(join(dir, file), body);
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir, stdio: 'pipe' });
}

/** @returns exit code of the scanner */
function scan(dir: string, base: string): number {
  try {
    execFileSync('node', [SCANNER, '--diff', base], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

describe('secret-scan --diff scans what it claims (finding #5)', () => {
  it('FAILS when a secret is added then removed before the tip', () => {
    // The net diff is clean, but the credential is still in the pushed history.
    // The old scanner took the file list from the diff and content from HEAD, so it
    // reported clean. Per-commit scanning is what makes this fail.
    repo = newRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    commit(repo, 'leak.txt', `token = "${REAL_PAT}"\n`, 'oops');
    commit(repo, 'leak.txt', 'token = "removed"\n', 'redact');
    expect(scan(repo, base)).toBe(1);
  });

  it('FAILS when a secret is present in the final diff', () => {
    repo = newRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    commit(repo, 'leak.txt', `token = "${REAL_PAT}"\n`, 'add secret');
    expect(scan(repo, base)).toBe(1);
  });

  it('PASSES when no commit in the range introduces a secret', () => {
    repo = newRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    commit(repo, 'ok.txt', 'just some code\n', 'benign');
    commit(
      repo,
      'ok2.txt',
      'const DIRECT = "postgresql://u:p@ep-x.aws.neon.tech/db";\n',
      'fixture only',
    );
    expect(scan(repo, base)).toBe(0);
  });
});
