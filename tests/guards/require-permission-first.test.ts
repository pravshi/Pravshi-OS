import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Task 1.15 — blueprint section 24, "requirePermission is the first statement", enforced.
 *
 * Every Route Handler and every Server Action under src/ must establish authorization before
 * any business logic runs:
 *
 *   Route Handler  every exported HTTP method is `export const METHOD = withPermission(...)`
 *   Server Action  the first statement of every exported function awaits requirePermission(),
 *                  and Server Actions live only in modules that start with 'use server'
 *
 * The only exceptions are the eight routes below, each of which is pre-authentication or gated
 * by its own credential. The list is exact: a new entry is a reviewed change to this file, there
 * is no annotation or comment that exempts a file, and a stale entry fails the build.
 *
 * Like the other guards this is a heuristic over source text, not a type proof, so it fails
 * closed: an export shape it does not recognise, a wildcard re-export, or a 'use server'
 * directive anywhere but the top of a module is a failure, never a pass. It is paired with two
 * structural barriers: services take an Authorization that only requirePermission() can issue,
 * and RLS returns nothing to a query that carries no identity.
 */

const PRE_AUTH_ROUTES = [
  // Better Auth itself: it establishes identity, so it cannot require one.
  'src/app/api/auth/[...all]/route.ts',
  // Task 1.14: the one-time setup token is the credential; no session exists yet.
  'src/app/api/bootstrap/complete/route.ts',
  // Task 1.17: the invitation token is the credential; no session exists yet. The accept
  // page reads it from the URL fragment and posts it in the body, so it never appears
  // in a request line or an access log.
  'src/app/api/invitations/preview/route.ts',
  'src/app/api/invitations/accept/route.ts',
  // Task 1.18: these routes establish identity, so they cannot require one. They
  // delegate to Better Auth and record every outcome as a login event.
  'src/app/api/auth/login/route.ts',
  'src/app/api/auth/mfa/verify/route.ts',
  // Password reset: the emailed token is the credential; no session exists yet.
  // The forgot endpoint answers generic success to every caller so it cannot
  // become an account-enumeration oracle; the reset endpoint's token is
  // single-use and unguessable.
  'src/app/api/auth/forgot-password/route.ts',
  'src/app/api/auth/reset-password/route.ts',
  // Public liveness. Touches nothing, by guard.
  'src/app/health/route.ts',
  // Database reachability for CI and humans, gated by HEALTH_CHECK_TOKEN.
  'src/app/health/db/route.ts',
] as const;

const METHODS = 'GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry))
      out.push(relative(process.cwd(), path).split('\\').join('/'));
  }
  return out;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Problems with a Route Handler file, or none. */
export function analyseRoute(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  for (const m of code.matchAll(
    new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*(${METHODS})\\b`, 'g'),
  )) {
    problems.push(
      `${m[1]} is declared as a function; use export const ${m[1]} = withPermission(...)`,
    );
  }
  for (const m of code.matchAll(
    new RegExp(`export\\s+(const|let|var)\\s+(${METHODS})\\b\\s*(?::[^=]*)?=\\s*([^;]{0,80})`, 'g'),
  )) {
    if (m[1] !== 'const' || !/^withPermission\s*(?:<[^>]*>\s*)?\(/.test(m[3] ?? '')) {
      problems.push(`${m[2]} is not built as export const ${m[2]} = withPermission(...)`);
    }
  }
  if (new RegExp(`export\\s*\\{[^}]*\\b(${METHODS})\\b[^}]*\\}`).test(code)) {
    problems.push('HTTP methods are re-exported, which this guard cannot verify');
  }
  if (/export\s+(?:const|let|var)\s*[{[]/.test(code)) {
    problems.push('exports are destructured, which this guard cannot verify');
  }
  if (/export\s*\*/.test(code)) {
    problems.push('the file re-exports a whole module, which this guard cannot verify');
  }
  return problems;
}

const isServerActionFile = (source: string) =>
  /^\s*['"]use server['"]/.test(stripComments(source).replace(/^\s+/, ''));

/** A 'use server' directive anywhere but the top of the module is an inline Server Action. */
export const hasInlineServerAction = (source: string) =>
  /['"]use server['"]/.test(stripComments(source).replace(/^\s*(['"])use server\1;?/, ''));

/** The only first statements that authorize unconditionally, before anything else runs. */
const AUTHORIZES_FIRST =
  /^(?:(?:const|let)\s+(?:\w+|\{[^}]*\})\s*=\s*)?await\s+requirePermission\s*\(/;

/** Problems with a 'use server' file, or none. */
export function analyseServerActions(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  const declarations = [
    ...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g),
    ...code.matchAll(/export\s+const\s+(\w+)\s*=\s*async\s*\([^)]*\)[^=]*=>\s*\{/g),
  ];
  for (const m of declarations) {
    let body = code.slice((m.index ?? 0) + m[0].length).replace(/^\s+/, '');
    if (body.startsWith('try')) body = body.replace(/^try\s*\{\s*/, '');
    const firstStatement = body.slice(0, body.indexOf(';') + 1);
    if (!AUTHORIZES_FIRST.test(firstStatement)) {
      problems.push(`${m[1]} does not await requirePermission() as its first statement`);
    }
  }
  // Every runtime export of a 'use server' module is callable from the client, so every one must
  // be a shape the loop above has read. Type-only exports are erased and cannot be called.
  const runtimeExports = [...code.matchAll(/\bexport\s+(?!type\b|interface\b)/g)].length;
  if (runtimeExports !== declarations.length) {
    problems.push(
      `${runtimeExports - declarations.length} export(s) are not an async function this guard can verify`,
    );
  }
  return problems;
}

const sources = walk('src').map((file) => ({ file, source: readFileSync(file, 'utf8') }));

describe('the analysers themselves', () => {
  it('accept a route built with withPermission and refuse every other shape', () => {
    expect(
      analyseRoute(
        `export const GET = withPermission({ permission: 'people.view' }, async () => x);`,
      ),
    ).toEqual([]);
    expect(
      analyseRoute(`export const DELETE = withPermission<{ id: string }>(spec, handler);`),
    ).toEqual([]);
    expect(analyseRoute(`export async function GET() { return x; }`)).toHaveLength(1);
    expect(analyseRoute(`export const POST = handler;`)).toHaveLength(1);
    expect(analyseRoute(`export let PUT = withPermission(a, b);`)).toHaveLength(1);
    expect(analyseRoute(`export const PATCH = (withPermission)(a, b);`)).toHaveLength(1);
    expect(analyseRoute(`const GET = withPermission(a, b); export { GET };`)).toHaveLength(1);
    expect(analyseRoute(`export const { GET, POST } = toNextJsHandler(auth);`)).toHaveLength(1);
    expect(analyseRoute(`export * from './handlers';`)).toHaveLength(1);
    // a comment cannot satisfy it
    expect(analyseRoute(`// withPermission\nexport async function DELETE() {}`)).toHaveLength(1);
  });

  it('accept an action that authorizes first and refuse one that does anything before', () => {
    expect(
      analyseServerActions(`'use server';
        export type SaveInput = { id: string };
        export async function save(input: SaveInput) {
          try {
            const authorization = await requirePermission(new Headers(await headers()), { permission: 'people.edit' });
            return service(authorization, input);
          } catch (error) { return actionError(error); }
        }`),
    ).toEqual([]);
    expect(
      analyseServerActions(`'use server';
        export async function save(input: unknown) {
          const row = await db.update(input);
          await requirePermission(h, { permission: 'people.edit' });
        }`),
    ).toHaveLength(1);
    expect(
      analyseServerActions(`'use server';
        export const remove = async (id: string) => { await doIt(id); };`),
    ).toHaveLength(1);
  });

  it('refuses an authorization that is not awaited, or not unconditional', () => {
    for (const statement of [
      `requirePermission(h, { permission: 'people.edit' });`,
      `const pending = requirePermission(h, { permission: 'people.edit' });`,
      `if (flag) await requirePermission(h, { permission: 'people.edit' });`,
      `await Promise.all([requirePermission(h, p), doIt()]);`,
    ]) {
      expect(
        analyseServerActions(`'use server';\nexport async function save() { ${statement} }`),
        statement,
      ).toHaveLength(1);
    }
  });

  it('refuses every action export it cannot read', () => {
    for (const source of [
      `export default async function save() { await requirePermission(h, p); }`,
      `export const save = withSomething(async () => { await requirePermission(h, p); });`,
      `export function save() { return requirePermission(h, p); }`,
      `export * from './elsewhere';`,
      `async function save() { await requirePermission(h, p); }\nexport { save };`,
    ]) {
      expect(analyseServerActions(`'use server';\n${source}`), source).toHaveLength(1);
    }
  });

  it('recognises a use server directive only at the top of a file', () => {
    expect(isServerActionFile(`'use server';\nexport async function a() {}`)).toBe(true);
    expect(isServerActionFile(`/** doc */\n"use server";`)).toBe(true);
    expect(isServerActionFile(`const note = 'use server';`)).toBe(false);
  });

  it('finds an inline Server Action, and nothing in a module-level one', () => {
    expect(
      hasInlineServerAction(
        `export default function Page() { async function save() { 'use server'; await db.write(); } }`,
      ),
    ).toBe(true);
    expect(hasInlineServerAction(`'use server';\nexport async function a() {}`)).toBe(false);
    expect(hasInlineServerAction(`// 'use server' in a comment\nexport const x = 1;`)).toBe(false);
  });
});

describe('every protected entry point authorizes first', () => {
  it('keeps the pre-authentication allow-list exact, and every entry real', () => {
    expect(PRE_AUTH_ROUTES).toHaveLength(10);
    for (const file of PRE_AUTH_ROUTES) expect(existsSync(file), file).toBe(true);
  });

  it('builds every other Route Handler with withPermission()', () => {
    const routes = sources.filter(
      ({ file }) =>
        /\/route\.(ts|tsx|js|jsx|mjs)$/.test(file) &&
        !(PRE_AUTH_ROUTES as readonly string[]).includes(file),
    );
    for (const { file, source } of routes) {
      expect(analyseRoute(source), file).toEqual([]);
    }
  });

  it('opens every Server Action with requirePermission()', () => {
    for (const { file, source } of sources.filter(({ source }) => isServerActionFile(source))) {
      expect(analyseServerActions(source), file).toEqual([]);
    }
  });

  it('declares Server Actions only in modules that start with use server', () => {
    for (const { file, source } of sources) {
      expect(hasInlineServerAction(source), file).toBe(false);
    }
  });

  it('keeps the authorization engine out of client components', () => {
    const client = sources.filter(({ source }) =>
      /^\s*['"]use client['"]/.test(stripComments(source).replace(/^\s+/, '')),
    );
    for (const { file, source } of client) {
      expect(source, file).not.toMatch(/from\s+['"]@\/lib\/(authz|audit)\b/);
    }
  });

  it('lets nothing outside the engine call the decision function directly', () => {
    for (const { file, source } of sources) {
      if (file.startsWith('src/lib/authz/')) continue;
      expect(source, file).not.toMatch(/\bdecideAuthorization\b/);
    }
  });
});
