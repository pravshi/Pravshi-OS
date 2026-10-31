import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ADR-010 — module layers and dependency rules, enforced.
 *
 * Builds the import graph of src/ — static imports, `import type`, `export … from` re-exports,
 * side-effect imports and dynamic `import()` — using TypeScript's own import scanner
 * (ts.preProcessFile), resolves every `@/…` and relative specifier to a file, maps every file to a
 * module and every module to a layer, and checks:
 *
 *   rule 1  downward only: no import from a lower layer to a higher one (L2's internal order:
 *           audit < auth < authz; identity imports L1 and below only)
 *   rule 2  the control plane (platform) imports L0–L2 only; no src/lib module imports platform
 *   rule 3  L4 → L4 only along the permitted edges
 *   rule 5  the queue core (jobs) imports no L4 module
 *   rule 7  src/lib only: a `_`-prefixed file or an `internal/` folder of a src/lib module is
 *           imported only from inside that module
 *   cycle   the module graph, minus the baselined edges, has no cycle
 *
 * Fail-closed, like the other guards: an unmapped file or module, an unresolvable `@/` or relative
 * specifier, or a dynamic import()/require() whose argument is not a string literal is a failure,
 * never a pass.
 *
 * BASELINE. The violations that existed when this guard landed (main at eb4eca3) are listed in
 * BASELINE, one entry per importing FILE and target module, so a second file adding an already
 * baselined module edge still fails. The baseline may only shrink: a violation not in it fails, and
 * an entry whose violation no longer exists fails too — remove the entry in the same change that
 * removes its cause. Steps 4–6 of docs/architecture/target-architecture.md empty it.
 */

// ── the module and layer map (ADR-010 "Layers") ────────────────────────────────────────────

type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'control' | 'entry';

/** Rank for rule 1; entry points sit above everything. */
const RANK: Record<Layer, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, control: 5, entry: 6 };

/** Every module, by name. A src/lib directory or file not listed here fails the guard. */
const MODULE_LAYER: Readonly<Record<string, Layer>> = {
  // L0 configuration
  env: 'L0',
  utils: 'L0',
  // L1 infrastructure
  db: 'L1',
  observability: 'L1',
  storage: 'L1',
  // L2 security and identity
  audit: 'L2',
  auth: 'L2',
  authz: 'L2',
  identity: 'L2',
  // L3 shared services
  jobs: 'L3',
  notifications: 'L3',
  events: 'L3', // the domain-event ports (Step 6): what crm, work and integrations emit through
  // L4 tenant domain modules
  crm: 'L4',
  work: 'L4',
  workflows: 'L4',
  integrations: 'L4',
  import: 'L4',
  ai: 'L4',
  analytics: 'L4',
  search: 'L4',
  admin: 'L4',
  invitations: 'L4',
  // control plane
  platform: 'control',
  // entry points and the frontend they compose. ADR-010 names src/app; src/components,
  // src/hooks and src/middleware.ts are mapped to the same tier — frontend and middleware
  // consumed only by src/app, imported by no src/lib module.
  app: 'entry',
  // src/worker: the background worker's entry point and job handlers (Step 5). It composes the
  // queue core and the domain modules, like src/app, and no src/lib module may import it.
  worker: 'entry',
  // src/lib/composition: the composition roots that connect subscribers to the domain-event ports
  // (Step 6). They import workflows and integrations, so they sit above the domain modules like an
  // entry point; being 'entry', no other src/lib module may import them.
  composition: 'entry',
  components: 'entry',
  hooks: 'entry',
  middleware: 'entry',
  // src/instrumentation.ts: Next's start-up hook (Step 6) — loads the composition root.
  instrumentation: 'entry',
};

/** L2's internal order (ADR-010): a lower index may not import a higher one. */
const L2_ORDER: readonly string[] = ['audit', 'auth', 'authz'];

/** Rule 3: the only permitted L4 → L4 edges. */
const L4_EDGES: ReadonlySet<string> = new Set([
  'workflows->crm',
  'workflows->work',
  'workflows->integrations',
  'ai->crm',
  'ai->work',
  'analytics->work',
  'import->crm',
]);

// ── the baseline: empty since Step 6 (it held 17 entries at eb4eca3) ──────────────────────

type Rule = 'rule-1' | 'rule-2' | 'rule-3' | 'rule-5' | 'rule-7' | 'cycle';

/** `<importing file> -> <target module> [<rule>]`, with the step that removes it. */
const BASELINE: readonly string[] = [];

// ── the analysis (pure: the self-tests at the bottom run it on synthetic graphs) ──────────

export interface FileImport {
  readonly from: string; // repository-relative importing file
  readonly toFile: string; // repository-relative resolved file
}

export interface Violation {
  readonly key: string; // `<file> -> <module> [<rule>]`
  readonly detail: string;
}

/** Module of a repository-relative src/ path, or null when it is not mapped. */
export function moduleOf(file: string): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'src') return null;
  let name: string | undefined;
  if (parts[1] === 'lib') {
    const seg = parts[2];
    if (seg === undefined) return null;
    name = parts.length === 3 ? seg.replace(/\.(ts|tsx|js|mjs)$/, '') : seg;
  } else if (parts.length === 2) {
    name = (parts[1] ?? '').replace(/\.(ts|tsx|js|mjs)$/, '');
  } else {
    name = parts[1];
  }
  return name !== undefined && name in MODULE_LAYER ? name : null;
}

const isLib = (file: string) => file.startsWith('src/lib/');

/** Rule 7: a `_`-prefixed file or a file under `internal/` inside a src/lib module. */
function isPrivateLibFile(file: string): boolean {
  if (!isLib(file)) return false;
  const inside = file.split('/').slice(3); // path below src/lib/<module>/
  return (
    inside.some((seg, i) => seg === 'internal' && i < inside.length - 1) ||
    (inside.at(-1) ?? '').startsWith('_')
  );
}

/** The rule a module edge breaks, ignoring cycles; null when it is permitted. */
export function ruleFor(from: string, to: string): Rule | null {
  const a = MODULE_LAYER[from];
  const b = MODULE_LAYER[to];
  if (a === undefined || b === undefined) throw new Error(`unmapped module ${from} or ${to}`);
  if (a === 'entry') return null;
  if (b === 'entry') return 'rule-1';
  if (to === 'platform') return 'rule-2';
  if (a === 'control') return RANK[b] <= RANK.L2 ? null : 'rule-2';
  if (a === 'L3' && from === 'jobs' && b === 'L4') return 'rule-5';
  if (RANK[b] > RANK[a]) return 'rule-1';
  if (a === 'L4' && b === 'L4') return L4_EDGES.has(`${from}->${to}`) ? null : 'rule-3';
  if (a === 'L2' && b === 'L2') {
    if (from === 'identity') return 'rule-1';
    const i = L2_ORDER.indexOf(from);
    const j = L2_ORDER.indexOf(to);
    if (i !== -1 && j !== -1 && j > i) return 'rule-1';
  }
  return null;
}

/** Cycles in the module graph after removing the baselined edges, each as its member list. */
export function cyclesOf(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) out.push(scc.sort());
    }
  };
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** Every violation in a file-level import list, given a baseline (used to cut cycle edges). */
export function violationsOf(
  imports: readonly FileImport[],
  baseline: readonly string[],
): Violation[] {
  const found = new Map<string, Violation>();
  const add = (key: string, detail: string) => {
    if (!found.has(key)) found.set(key, { key, detail });
  };
  // file → module edges, per rule
  const moduleEdgeFiles = new Map<string, Set<string>>(); // "a->b" → importing files
  for (const { from, toFile } of imports) {
    const a = moduleOf(from);
    const b = moduleOf(toFile);
    if (a === null) throw new Error(`unmapped file ${from}`);
    if (b === null) throw new Error(`unmapped file ${toFile} (imported by ${from})`);
    if (isPrivateLibFile(toFile) && a !== b) {
      add(`${from} -> ${b} [rule-7]`, `${from} imports the private file ${toFile}`);
    }
    if (a === b) continue;
    const rule = ruleFor(a, b);
    if (rule !== null) add(`${from} -> ${b} [${rule}]`, `${from} imports ${toFile}`);
    const k = `${a}->${b}`;
    if (!moduleEdgeFiles.has(k)) moduleEdgeFiles.set(k, new Set());
    moduleEdgeFiles.get(k)!.add(from);
  }
  // cycle check on the module graph minus baselined edges: an edge is cut only when every file
  // contributing it is baselined (any rule), so a new file re-adding a cut edge is still seen.
  const baselined = new Set(baseline.map((e) => e.replace(/ \[[^\]]+\]$/, '')));
  const graph = new Map<string, Set<string>>();
  for (const [k, files] of moduleEdgeFiles) {
    const [a, b] = k.split('->') as [string, string];
    if (MODULE_LAYER[a] === 'entry') continue; // entry points sit on top; they cannot close a cycle
    const live = [...files].filter((f) => !baselined.has(`${f} -> ${b}`));
    if (live.length === 0) continue;
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)!.add(b);
  }
  for (const scc of cyclesOf(graph)) {
    for (const [k, files] of moduleEdgeFiles) {
      const [a, b] = k.split('->') as [string, string];
      if (!scc.includes(a) || !scc.includes(b)) continue;
      for (const f of files) {
        if (baselined.has(`${f} -> ${b}`)) continue;
        add(`${f} -> ${b} [cycle]`, `cycle through ${scc.join(', ')}`);
      }
    }
  }
  // A baselined cycle edge stays a violation while it would still close a cycle: while the graph
  // without the cut edges leads from its target back to its source. Once that path is gone the
  // entry is stale and must be removed.
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const v = queue.shift()!;
      if (v === to) return true;
      for (const w of graph.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          queue.push(w);
        }
      }
    }
    return false;
  };
  for (const entry of baseline) {
    const m = /^(.+) -> (\S+) \[cycle\]$/.exec(entry);
    if (m === null) continue;
    const [, f, b] = m as unknown as [string, string, string];
    const a = moduleOf(f);
    if (a === null || !(moduleEdgeFiles.get(`${a}->${b}`)?.has(f) ?? false)) continue;
    if (reaches(b, a)) add(entry, `baselined edge closing a cycle ${a} -> ${b} -> … -> ${a}`);
  }
  return [...found.values()].sort((x, y) => x.key.localeCompare(y.key));
}

// ── reading src/ ──────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(relative(ROOT, path).split('\\').join('/'));
  }
  return out;
}

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null; // a package import: outside the graph
  for (const ext of EXTENSIONS) {
    const candidate = normalize(base + ext);
    if (existsSync(join(ROOT, candidate)) && statSync(join(ROOT, candidate)).isFile()) {
      return candidate.split('\\').join('/');
    }
  }
  throw new Error(`${from}: cannot resolve '${spec}'`);
}

/**
 * Every module specifier a file names, from its syntax tree: import and `import type`
 * declarations, `export … from`, `import x = require()`, dynamic `import()`, `require()` and
 * `import('…')` type references. A dynamic import()/require() whose argument is not a string
 * literal cannot be resolved, so it is reported, never skipped.
 */
function specifiersOf(file: string, text: string): { specs: string[]; nonLiteral: string[] } {
  const kind =
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const nonLiteral: string[] = [];
  const literal = (n: ts.Node | undefined): string | null =>
    n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      ? n.text
      : null;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = literal(node.moduleSpecifier);
      if (s !== null) specs.push(s);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const s = literal(node.moduleReference.expression);
      if (s !== null) specs.push(s);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      if (dynamic) {
        const s = literal(node.arguments[0]);
        if (s !== null) specs.push(s);
        else nonLiteral.push(`${file}: ${node.getText(source).slice(0, 80)}`);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const s = literal(node.argument.literal);
      if (s !== null) specs.push(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specs, nonLiteral };
}

function readGraph(): { files: string[]; imports: FileImport[]; problems: string[] } {
  const files = walk(join(ROOT, 'src'));
  const imports: FileImport[] = [];
  const problems: string[] = [];
  for (const file of files) {
    if (moduleOf(file) === null) problems.push(`unmapped: ${file}`);
    if (!SOURCE.test(file)) continue;
    const { specs, nonLiteral } = specifiersOf(file, readFileSync(join(ROOT, file), 'utf8'));
    for (const n of nonLiteral) problems.push(`dynamic import with a non-literal argument: ${n}`);
    for (const spec of specs) {
      try {
        const toFile = resolveSpecifier(file, spec);
        if (toFile !== null) imports.push({ from: file, toFile });
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  for (const entry of readdirSync(join(ROOT, 'src', 'lib'))) {
    const name = entry.replace(/\.(ts|tsx|js|mjs)$/, '');
    if (!(name in MODULE_LAYER)) problems.push(`unmapped module: src/lib/${entry}`);
  }
  return { files, imports, problems };
}

// ── the guard ─────────────────────────────────────────────────────────────────────────────

describe('module boundaries (ADR-010)', () => {
  const { files, imports, problems } = readGraph();

  it('maps every file and module, and resolves every import', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(imports.length).toBeGreaterThan(500);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  const violations = violationsOf(imports, BASELINE);
  const keys = new Set(violations.map((v) => v.key));

  it('finds no violation outside the baseline', () => {
    const unexpected = violations.filter((v) => !BASELINE.includes(v.key));
    expect(
      unexpected.map((v) => `${v.key}  — ${v.detail}`),
      'New boundary violation(s). Fix the import; see ADR-010.',
    ).toEqual([]);
  });

  it('has no stale baseline entry (the baseline may only shrink)', () => {
    const stale = BASELINE.filter((entry) => !keys.has(entry));
    expect(stale, 'Remove these entries: their violation no longer exists.').toEqual([]);
  });

  it('keeps the baseline free of duplicates', () => {
    expect(new Set(BASELINE).size).toBe(BASELINE.length);
  });
});

// ── the checker itself, on synthetic graphs ───────────────────────────────────────────────

describe('module-boundary checker', () => {
  const edge = (from: string, toFile: string): FileImport => ({ from, toFile });

  it('maps files to modules and refuses unknown ones', () => {
    expect(moduleOf('src/lib/crm/deals.ts')).toBe('crm');
    expect(moduleOf('src/lib/utils.ts')).toBe('utils');
    expect(moduleOf('src/env.ts')).toBe('env');
    expect(moduleOf('src/middleware.ts')).toBe('middleware');
    expect(moduleOf('src/instrumentation.ts')).toBe('instrumentation');
    expect(moduleOf('src/app/(app)/crm/page.tsx')).toBe('app');
    expect(moduleOf('src/worker/runner.ts')).toBe('worker');
    expect(moduleOf('src/lib/newthing/x.ts')).toBeNull();
    expect(moduleOf('src/other/x.ts')).toBeNull();
    expect(() => violationsOf([edge('src/lib/newthing/x.ts', 'src/lib/db/pool.ts')], [])).toThrow(
      /unmapped/,
    );
  });

  it('applies rules 1, 2, 3 and 5', () => {
    expect(ruleFor('db', 'auth')).toBe('rule-1');
    expect(ruleFor('audit', 'auth')).toBe('rule-1');
    expect(ruleFor('authz', 'auth')).toBeNull();
    expect(ruleFor('identity', 'audit')).toBe('rule-1');
    expect(ruleFor('crm', 'platform')).toBe('rule-2');
    expect(ruleFor('platform', 'crm')).toBe('rule-2');
    expect(ruleFor('platform', 'jobs')).toBe('rule-2');
    expect(ruleFor('platform', 'auth')).toBeNull();
    expect(ruleFor('crm', 'workflows')).toBe('rule-3');
    expect(ruleFor('workflows', 'crm')).toBeNull();
    expect(ruleFor('jobs', 'work')).toBe('rule-5');
    expect(ruleFor('notifications', 'crm')).toBe('rule-1');
    expect(ruleFor('crm', 'app')).toBe('rule-1');
    expect(ruleFor('jobs', 'worker')).toBe('rule-1'); // the queue never imports the worker
    expect(ruleFor('crm', 'worker')).toBe('rule-1');
    expect(ruleFor('worker', 'jobs')).toBeNull(); // the worker imports the queue core downward
    expect(ruleFor('worker', 'import')).toBeNull();
    expect(ruleFor('crm', 'events')).toBeNull(); // domain modules emit through the L3 port
    expect(ruleFor('integrations', 'events')).toBeNull();
    expect(ruleFor('events', 'workflows')).toBe('rule-1'); // the port never imports a subscriber
    expect(ruleFor('events', 'integrations')).toBe('rule-1');
    expect(ruleFor('crm', 'composition')).toBe('rule-1'); // only entry points load the composition root
    expect(ruleFor('events', 'composition')).toBe('rule-1');
    expect(ruleFor('composition', 'workflows')).toBeNull();
    expect(ruleFor('crm', 'workflows')).toBe('rule-3'); // the reaction edges are gone for good
    expect(ruleFor('app', 'platform')).toBeNull();
  });

  it('applies rule 7 to src/lib only', () => {
    const v = violationsOf(
      [
        edge('src/lib/crm/a.ts', 'src/lib/work/_private.ts'),
        edge('src/lib/crm/b.ts', 'src/lib/db/internal/x.ts'),
        edge('src/lib/work/c.ts', 'src/lib/work/_private.ts'),
        edge('src/app/x/page.tsx', 'src/app/x/_actions.ts'),
      ],
      [],
    ).map((x) => x.key);
    expect(v).toContain('src/lib/crm/a.ts -> work [rule-7]');
    expect(v).toContain('src/lib/crm/b.ts -> db [rule-7]');
    expect(v.some((k) => k.startsWith('src/lib/work/c.ts'))).toBe(false);
    expect(v.some((k) => k.startsWith('src/app/'))).toBe(false);
  });

  it('finds a cycle of permitted edges, and cuts only fully baselined edges', () => {
    const cyc = [edge('src/env.ts', 'src/lib/utils.ts'), edge('src/lib/utils.ts', 'src/env.ts')];
    expect(violationsOf(cyc, []).map((x) => x.key)).toEqual([
      'src/env.ts -> utils [cycle]',
      'src/lib/utils.ts -> env [cycle]',
    ]);
    expect(violationsOf(cyc, ['src/lib/utils.ts -> env [cycle]']).map((x) => x.key)).toEqual([
      'src/lib/utils.ts -> env [cycle]',
    ]);
    // a second file contributing a cut edge keeps the cycle alive
    const l3 = [
      edge('src/lib/jobs/a.ts', 'src/lib/notifications/n.ts'),
      edge('src/lib/jobs/b.ts', 'src/lib/notifications/n.ts'),
      edge('src/lib/notifications/n.ts', 'src/lib/jobs/q.ts'),
    ];
    expect(
      violationsOf(l3, ['src/lib/jobs/a.ts -> notifications [cycle]']).map((x) => x.key),
    ).toEqual([
      'src/lib/jobs/a.ts -> notifications [cycle]',
      'src/lib/jobs/b.ts -> notifications [cycle]',
      'src/lib/notifications/n.ts -> jobs [cycle]',
    ]);
    expect(
      violationsOf(l3, [
        'src/lib/jobs/a.ts -> notifications [cycle]',
        'src/lib/jobs/b.ts -> notifications [cycle]',
      ]).map((x) => x.key),
    ).toEqual([
      'src/lib/jobs/a.ts -> notifications [cycle]',
      'src/lib/jobs/b.ts -> notifications [cycle]',
    ]);
  });
});
