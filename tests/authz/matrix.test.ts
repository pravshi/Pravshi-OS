import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAuthContext } from '@/lib/auth/session';
import { requirePermission, type AccessScope } from '@/lib/authz/require-permission';
import { withAuthorizedDb } from '@/lib/db/authorized';
import {
  enrolTotp,
  headersFor,
  mapLimit,
  mkAccount,
  mkDept,
  mkOrg,
  outcomeOf,
  ownerPool,
  runId,
  type Account,
} from './fixtures';

/**
 * Task 1.15 — the security.md section 2 matrix, cell by cell, through requirePermission().
 *
 * security.md 5.1: the matrix is "generated FROM the tables in section 2 — the doc IS the test
 * fixture". The table is parsed when this file loads, so a document change that behaviour does
 * not follow fails here, and so does behaviour that drifts from the document.
 *
 * One person per seeded role, holding that role and nothing else, with a live engagement and a
 * real session. The roles that carry a sensitive permission at GLOBAL are first shown to need a
 * step-up at aal1, then enrolled in TOTP and answered at aal2. Every cell is one real call.
 */

type Cell = AccessScope | null;

interface Matrix {
  roles: string[];
  rows: { permission: string; printed: Record<string, Cell> }[];
}

const LETTERS: Readonly<Record<string, AccessScope>> = {
  G: 'GLOBAL',
  D: 'DEPARTMENT',
  T: 'TEAM',
  P: 'PROJECT',
  S: 'SELF',
};

/** 0008: a grant carries one scope, so a printed union is seeded as its narrower half. */
const UNION_CELLS: Readonly<Record<string, AccessScope>> = { 'S+P': 'SELF' };

/** The em dash the document prints for "no access". */
const NO_ACCESS = '—';
const FOOTNOTE_MARKS = /[¹²³⁰-⁹]/g;

/**
 * Where the seed deliberately differs from a printed cell, with the migration that decided it.
 * Any other difference fails. Each entry must still differ from the document, so this list cannot
 * quietly outlive the discrepancy it records.
 */
const SEED_DECISIONS: Readonly<Record<string, Cell>> = {
  // 0008 gives SUPER_ADMIN the whole catalogue at GLOBAL, users.impersonate excepted. The printed
  // S in this row is the one cell of the matrix where that differs.
  'SUPER_ADMIN policies.acknowledge': 'GLOBAL',
};

/** Blueprint 6.1 roles with no matrix column; 0008 seeds them with no grants at all.
 * Phase 4 (0042) grants MANAGER six work permissions plus policies.acknowledge,
 * so only MARKETING remains unmapped. */
const UNMAPPED_ROLES = ['MARKETING'];

/** Task 1.15 decision 1: the set the catalogue must produce on its own, with no role named in code. */
const PRIVILEGED = ['ADMIN', 'FINANCE', 'HR_ADMIN', 'SUPER_ADMIN'];

function readCell(raw: string, where: string): Cell {
  const cell = raw.replace(FOOTNOTE_MARKS, '').trim();
  if (cell === NO_ACCESS) return null;
  const scope = UNION_CELLS[cell] ?? LETTERS[cell];
  if (!scope) throw new Error(`security.md section 2: cannot read "${raw}" at ${where}`);
  return scope;
}

function parseMatrix(markdown: string): Matrix {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\|\s*Permission\s*\|/.test(line));
  if (header === -1) throw new Error('security.md section 2: matrix header not found');
  if (!/^\|(\s*-+\s*\|)+$/.test(lines[header + 1]?.trim() ?? '')) {
    throw new Error('security.md section 2: matrix separator row not found');
  }
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const roles = cells(lines[header]!).slice(1);
  const rows: Matrix['rows'] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [first, ...values] = cells(line);
    const permission = (first ?? '').replace(/`/g, '');
    if (values.length !== roles.length) {
      throw new Error(
        `security.md section 2: ${permission} has ${values.length} cells for ${roles.length} roles`,
      );
    }
    const printed: Record<string, Cell> = {};
    roles.forEach((role, i) => {
      printed[role] = readCell(values[i]!, `${role} / ${permission}`);
    });
    rows.push({ permission, printed });
  }
  return { roles, rows };
}

const matrix = parseMatrix(
  readFileSync(new URL('../../docs/architecture/security.md', import.meta.url), 'utf8'),
);
const ROLES = [...matrix.roles, ...UNMAPPED_ROLES];

const expectedScope = (role: string, permission: string, printed: Record<string, Cell>): Cell => {
  const decision = `${role} ${permission}`;
  return decision in SEED_DECISIONS ? (SEED_DECISIONS[decision] ?? null) : (printed[role] ?? null);
};

const owner = ownerPool();
const RUN = runId();

let org = '';
let seededRoles: string[] = [];
let catalogue: string[] = [];
const accounts: Record<string, Account> = {};
const atAal1: Record<string, string> = {};

beforeAll(async () => {
  org = await mkOrg(owner, `mx-${RUN}`);
  const dept = await mkDept(owner, org, `M${RUN.toUpperCase()}`);

  const created = await mapLimit(ROLES, 4, (role) =>
    mkAccount(owner, {
      org,
      dept,
      run: RUN,
      label: `mx${role.toLowerCase().replace(/_/g, '')}`,
      roles: [role],
    }),
  );
  ROLES.forEach((role, i) => {
    accounts[role] = created[i]!;
  });

  seededRoles = (
    await owner.query<{ key: string }>(`select key from public.roles where org_id = $1`, [org])
  ).rows.map((r) => r.key);
  catalogue = (await owner.query<{ key: string }>(`select key from public.permissions`)).rows.map(
    (r) => r.key,
  );

  // Before anybody is enrolled: which roles does requirePermission() send to a step-up?
  const outcomes = await mapLimit(ROLES, 4, (role) =>
    outcomeOf(
      requirePermission(headersFor(accounts[role]!.cookie), {
        permission: 'policies.acknowledge',
      }),
    ),
  );
  ROLES.forEach((role, i) => {
    atAal1[role] = outcomes[i]!.code;
  });

  // Then the privileged set, and only it, verifies a second factor; its cells are answered at aal2.
  await mapLimit(PRIVILEGED, 2, async (role) => {
    const enrolled = await enrolTotp(accounts[role]!.cookie);
    accounts[role] = {
      ...accounts[role]!,
      cookie: enrolled.cookie,
      secret: enrolled.secret,
    };
  });
}, 300_000);

afterAll(async () => {
  await owner.end().catch(() => undefined);
});

describe('the matrix as written', () => {
  it('has 67 permissions for 13 roles', () => {
    expect(matrix.roles).toEqual([
      'SUPER_ADMIN',
      'ADMIN',
      'HR_ADMIN',
      'HR_MANAGER',
      'MANAGER',
      'SALES_MANAGER',
      'SALES',
      'PROJECT_MANAGER',
      'DEVELOPER',
      'VIBECODER',
      'INTERN',
      'FINANCE',
      'EMPLOYEE',
    ]);
    expect(matrix.rows).toHaveLength(67);
    expect(new Set(matrix.rows.map((r) => r.permission)).size).toBe(67);
  });

  it('names only permissions in the catalogue', () => {
    expect(matrix.rows.map((r) => r.permission).filter((p) => !catalogue.includes(p))).toEqual([]);
  });

  it('covers every seeded role, plus the two it has no column for', () => {
    expect([...seededRoles].sort()).toEqual([...ROLES].sort());
  });

  it('records each seed decision against a cell that still says something else', () => {
    for (const [decision, seeded] of Object.entries(SEED_DECISIONS)) {
      const [role, permission] = decision.split(' ');
      const row = matrix.rows.find((r) => r.permission === permission);
      expect(row, decision).toBeDefined();
      expect(row!.printed[role!], decision).not.toBe(seeded);
    }
  });
});

describe('mandatory MFA', () => {
  it('is derived from the catalogue for exactly SUPER_ADMIN, ADMIN, HR_ADMIN and FINANCE', async () => {
    const { rows } = await owner.query<{ key: string }>(
      `select distinct r.key
       from public.roles r
       join public.role_permissions rp on rp.role_id = r.id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1 and p.is_sensitive and rp.scope = 'GLOBAL'`,
      [org],
    );
    expect(rows.map((r) => r.key).sort()).toEqual(PRIVILEGED);
  });

  it('sends exactly those roles to a step-up at aal1, and no other', () => {
    expect(ROLES.filter((role) => atAal1[role] === 'STEP_UP_REQUIRED').sort()).toEqual(PRIVILEGED);
    for (const role of ROLES.filter((r) => !PRIVILEGED.includes(r))) {
      expect(atAal1[role], role).toBe(UNMAPPED_ROLES.includes(role) ? 'FORBIDDEN' : 'SUCCEEDED');
    }
  });
});

describe.each(ROLES)('%s', (role) => {
  it('answers every cell of the matrix through requirePermission()', async () => {
    const account = accounts[role]!;
    const aal = PRIVILEGED.includes(role) ? 'aal2' : 'aal1';
    const mismatches = await mapLimit(matrix.rows, 4, async ({ permission, printed }) => {
      const want = expectedScope(role, permission, printed);
      const got = await requirePermission(headersFor(account.cookie), {
        permission,
      }).then(
        (authorization): string | null =>
          authorization.aal === aal
            ? authorization.scope
            : `${authorization.scope} at ${authorization.aal}`,
        (error: { code?: unknown }): string | null =>
          error?.code === 'FORBIDDEN' ? null : `refusal ${String(error?.code ?? error)}`,
      );
      return got === want
        ? null
        : `${permission}: expected ${want ?? 'FORBIDDEN'}, got ${got ?? 'FORBIDDEN'}`;
    });
    expect(mismatches.filter(Boolean)).toEqual([]);
  }, 180_000);

  it('holds nothing the matrix does not print', async () => {
    const ctx = await resolveAuthContext(headersFor(accounts[role]!.cookie));
    expect(ctx).not.toBeNull();
    const held = await withAuthorizedDb(ctx!, (tx) =>
      tx.execute<{ key: string; scope: string }>(
        sql`select p.key, authz.scope_for(p.key)::text as scope from public.permissions p`,
      ),
    );
    const actual = Object.fromEntries(held.rows.map((r) => [r.key, r.scope]));
    const expected: Record<string, string> =
      role === 'SUPER_ADMIN'
        ? Object.fromEntries(
            catalogue
              .filter((key) => key !== 'users.impersonate')
              .map((key): [string, string] => [key, 'GLOBAL']),
          )
        : Object.fromEntries(
            matrix.rows.flatMap(({ permission, printed }): [string, string][] => {
              const scope = expectedScope(role, permission, printed);
              return scope ? [[permission, scope]] : [];
            }),
          );
    expect(actual).toEqual(expected);
  }, 60_000);
});
