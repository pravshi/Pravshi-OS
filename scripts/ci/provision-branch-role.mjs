#!/usr/bin/env node
// PRAVSHI OS — ephemeral CI database branch (Task 11).
//
// Creates a throwaway Neon branch from the NON-PRODUCTION parent, gives it
// branch-only credentials, and hands CI two connection strings:
//
//   app_user  @ pooled host  -> DATABASE_URL / DATABASE_URL_TEST  (runtime + tests)
//   app_owner @ direct host  -> DATABASE_URL_MIGRATE              (migrations only)
//
// WHY THE PASSWORDS ARE RESET, rather than reused:
// a Neon branch inherits every role AND its password from its parent, so the
// inherited app_user password is byte-identical to production's. Reusing it would
// put a production-equivalent credential into CI. Resetting on the ephemeral branch
// yields a credential that exists only for that branch and dies with it. This was
// verified empirically before this script was written: resetting a role's password
// on a child branch leaves the parent's password working.
//
// The only secrets this needs are NEON_API_KEY and NEON_PROJECT_ID. It never sees,
// needs, or accepts a production connection string.
//
// Usage:
//   node scripts/ci/provision-branch-role.mjs create
//   node scripts/ci/provision-branch-role.mjs delete
//
// Env: NEON_API_KEY, NEON_PROJECT_ID, NEON_PARENT_BRANCH, CI_BRANCH_NAME

import { appendFileSync } from 'node:fs';

const API = 'https://console.neon.tech/api/v2';
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v.trim();
};

const KEY = need('NEON_API_KEY');
const PROJECT = need('NEON_PROJECT_ID');
const BRANCH_NAME = need('CI_BRANCH_NAME');

async function neon(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body verbatim: Neon error payloads can quote a connection URI.
    throw new Error(`Neon ${method} ${path.split('?')[0]} failed with HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Mask before anything else can print it, then write it to the step output. */
function emitSecret(name, value) {
  console.log(`::add-mask::${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function emitPlain(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

const pooled = (host) => {
  const label = host.split('.')[0];
  return host.replace(label, `${label}-pooler`);
};

const urlFor = (role, password, host, db) =>
  `postgresql://${role}:${encodeURIComponent(password)}@${host}/${db}?sslmode=require`;

/**
 * A freshly created branch is not immediately writable: Neon answers 423 Locked
 * while it initialises. Poll until it reports ready before touching its roles.
 */
async function waitUntilReady(branchId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { branch } = await neon('GET', `/projects/${PROJECT}/branches/${branchId}`);
    if (branch.current_state === 'ready') return;
    if (Date.now() > deadline) {
      throw new Error(
        `Branch ${branchId} was still "${branch.current_state}" after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function findBranch(name) {
  const { branches } = await neon('GET', `/projects/${PROJECT}/branches`);
  return branches.find((b) => b.name === name);
}

async function create() {
  const parent = need('NEON_PARENT_BRANCH');

  // Refuse to branch from the project default. The default branch is production,
  // and Task 11's entire premise is that CI never touches it.
  const { branches } = await neon('GET', `/projects/${PROJECT}/branches`);
  const parentBranch = branches.find((b) => b.id === parent || b.name === parent);
  if (!parentBranch) throw new Error('NEON_PARENT_BRANCH does not exist in this project');
  if (parentBranch.default) {
    throw new Error(
      'Refusing to create a CI branch from the DEFAULT (production) branch. ' +
        'NEON_PARENT_BRANCH must name the non-production parent.',
    );
  }

  const created = await neon('POST', `/projects/${PROJECT}/branches`, {
    branch: { name: BRANCH_NAME, parent_id: parentBranch.id },
    endpoints: [{ type: 'read_write' }],
  });

  const branchId = created.branch.id;
  const host = created.endpoints[0].host;
  await waitUntilReady(branchId);
  const { databases } = await neon('GET', `/projects/${PROJECT}/branches/${branchId}/databases`);
  const db = databases[0].name;

  // Branch-only credentials. See the header for why these are reset, not inherited.
  const reset = async (role) => {
    const r = await neon(
      'POST',
      `/projects/${PROJECT}/branches/${branchId}/roles/${role}/reset_password`,
    );
    if (!r?.role?.password) throw new Error(`Neon did not return a password for ${role}`);
    return r.role.password;
  };

  const appUserPw = await reset('app_user');
  const appOwnerPw = await reset('app_owner');

  emitPlain('branch_id', branchId);
  emitSecret('db_url_app', urlFor('app_user', appUserPw, pooled(host), db));
  emitSecret('db_url_migrate', urlFor('app_owner', appOwnerPw, host, db));

  console.log(`Created ephemeral branch ${BRANCH_NAME} (${branchId}) from ${parentBranch.name}`);
}

async function remove() {
  const branch = await findBranch(BRANCH_NAME);
  if (!branch) {
    console.log(`No branch named ${BRANCH_NAME}; nothing to delete.`);
    return;
  }
  if (branch.default) throw new Error('Refusing to delete the default branch');
  await neon('DELETE', `/projects/${PROJECT}/branches/${branch.id}`);
  console.log(`Deleted ephemeral branch ${BRANCH_NAME} (${branch.id})`);
}

const mode = process.argv[2];
if (mode === 'create') await create();
else if (mode === 'delete') await remove();
else {
  console.error('usage: provision-branch-role.mjs <create|delete>');
  process.exit(2);
}
