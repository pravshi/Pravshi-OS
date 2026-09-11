#!/usr/bin/env node
// PRAVSHI OS — first-run bootstrap (Task 1.14).
//
// Creates the organization, the Executive department, the owner, their ACTIVE engagement and
// the SUPER_ADMIN origin grant, in one transaction, by calling public.bootstrap_organization()
// as app_admin — then prints a one-time setup link. It runs ONCE per database; the database
// refuses every later attempt, whoever makes it. See scripts/bootstrap/README.md.
//
// Usage:
//   node scripts/bootstrap/run.mjs
//
// Settings come from the process environment first, then .env (parsed without expansion, by
// the same parser scripts/db/run.mjs uses):
//
//   DATABASE_URL_BOOTSTRAP   app_admin, DIRECT endpoint. Operator machine only.
//   APP_URL                  where the setup link points (https, or http for localhost)
//   BOOTSTRAP_ORG_NAME       e.g. PRAVSHI
//   BOOTSTRAP_ORG_SLUG       lower-case, digits and hyphens
//   BOOTSTRAP_OWNER_NAME     the owner's full legal name
//   BOOTSTRAP_OWNER_EMAIL    the owner's work email; becomes their login
//
// THE SETUP TOKEN. 32 bytes from the OS CSPRNG, base64url. Only its SHA-256 digest is sent to
// the database. The token itself exists in this process's memory and on the operator's
// terminal, once, and nowhere else: this script refuses to run when stdout is not an
// interactive terminal, so it cannot be redirected into a file or a CI log, and it refuses to
// run in CI at all. It writes no files.
//
// Every byte this process prints passes through a redactor built from the database URL, so a
// connection error cannot print the host or the password.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { installOutputRedaction, loadEnv } from '../db/run.mjs';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

export const SETUP_TOKEN_BYTES = 32;

const SETTINGS = [
  'DATABASE_URL_BOOTSTRAP',
  'APP_URL',
  'BOOTSTRAP_ORG_NAME',
  'BOOTSTRAP_ORG_SLUG',
  'BOOTSTRAP_OWNER_NAME',
  'BOOTSTRAP_OWNER_EMAIL',
];

// The organizations_slug_valid CHECK, restated so a bad slug is refused before connecting.
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// ---------------------------------------------------------------------------- token

export function generateSetupToken() {
  return randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
}

/** Hex SHA-256 of the token string — the digest src/lib/auth/bootstrap-setup.ts computes. */
export function hashSetupToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fragment, not a query string: fragments are never sent to a server or in a Referer. */
export function setupLinkFor(appOrigin, token) {
  const link = new URL('/setup', appOrigin);
  link.hash = `token=${token}`;
  return link.toString();
}

// --------------------------------------------------------------------------- config

/**
 * Process environment first, then .env. A blank value counts as unset.
 * @param {Record<string, string | undefined>} processEnv
 * @param {Map<string, string>} fileEnv
 * @returns {Record<string, string>}
 */
export function settingsFrom(processEnv, fileEnv) {
  const settings = {};
  for (const key of SETTINGS) {
    const value = processEnv[key] || fileEnv.get(key) || '';
    settings[key] = value.trim();
  }
  return settings;
}

/**
 * Validates every setting before anything touches a database. Problems name the setting,
 * never its value.
 * @param {Record<string, string>} settings
 * @param {Record<string, string | undefined>} [processEnv]
 */
export function readBootstrapConfig(settings, processEnv = process.env) {
  const problems = [];

  if (processEnv.CI || processEnv.GITHUB_ACTIONS) {
    problems.push('bootstrap never runs in CI (CI or GITHUB_ACTIONS is set)');
  }

  let databaseUrl = null;
  if (!settings.DATABASE_URL_BOOTSTRAP) {
    problems.push('DATABASE_URL_BOOTSTRAP is required');
  } else {
    try {
      databaseUrl = new URL(settings.DATABASE_URL_BOOTSTRAP);
    } catch {
      problems.push('DATABASE_URL_BOOTSTRAP is not a parseable connection string');
    }
  }
  if (databaseUrl) {
    if (!/^postgres(ql)?:$/.test(databaseUrl.protocol)) {
      problems.push('DATABASE_URL_BOOTSTRAP must be a postgres connection string');
    }
    if (databaseUrl.hostname.includes('-pooler')) {
      problems.push(
        'DATABASE_URL_BOOTSTRAP must use the direct endpoint (no "-pooler" in the host)',
      );
    }
    if (decodeURIComponent(databaseUrl.username) !== 'app_admin') {
      problems.push('DATABASE_URL_BOOTSTRAP must connect as the bootstrap role, app_admin');
    }
    if (!databaseUrl.password) problems.push('DATABASE_URL_BOOTSTRAP has no password');
    if (!databaseUrl.pathname.replace(/^\//, '')) {
      problems.push('DATABASE_URL_BOOTSTRAP has no database name');
    }
  }

  let appOrigin = null;
  if (!settings.APP_URL) {
    problems.push('APP_URL is required to build the setup link');
  } else {
    try {
      const url = new URL(settings.APP_URL);
      if (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
      ) {
        appOrigin = url.origin;
      } else {
        problems.push('APP_URL must be https (http only for localhost): the link carries a secret');
      }
    } catch {
      problems.push('APP_URL is not a valid URL');
    }
  }

  if (!settings.BOOTSTRAP_ORG_NAME) problems.push('BOOTSTRAP_ORG_NAME is required');
  if (!SLUG.test(settings.BOOTSTRAP_ORG_SLUG)) {
    problems.push('BOOTSTRAP_ORG_SLUG must be lower-case letters, digits and inner hyphens');
  }
  if (!settings.BOOTSTRAP_OWNER_NAME) problems.push('BOOTSTRAP_OWNER_NAME is required');
  if (!EMAIL.test(settings.BOOTSTRAP_OWNER_EMAIL)) {
    problems.push('BOOTSTRAP_OWNER_EMAIL is not a valid address');
  }

  if (problems.length > 0) {
    throw new Error(`bootstrap refused:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    databaseUrl,
    appOrigin,
    orgName: settings.BOOTSTRAP_ORG_NAME,
    orgSlug: settings.BOOTSTRAP_ORG_SLUG,
    ownerName: settings.BOOTSTRAP_OWNER_NAME,
    ownerEmail: settings.BOOTSTRAP_OWNER_EMAIL,
  };
}

// ------------------------------------------------------------------------ redaction

/** Password, host and endpoint label of the one database URL this script holds. */
export function redactorFor(connectionString) {
  const secrets = new Set([connectionString]);
  try {
    const url = new URL(connectionString);
    const label = url.hostname.split('.')[0];
    for (const value of [decodeURIComponent(url.password), url.host, url.hostname, label]) {
      if (value && value.length >= 6) secrets.add(value);
    }
  } catch {
    // unparseable: the whole-string and pattern redactions still apply
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (input) => {
    let text = typeof input === 'string' ? input : String(input);
    for (const secret of ordered) text = text.split(secret).join('[redacted]');
    return text.replace(/postgres(?:ql)?:\/\/\S*/gi, '[redacted]');
  };
}

// ------------------------------------------------------------------------ bootstrap

function clientConfig(databaseUrl) {
  const host = databaseUrl.hostname;
  return {
    host,
    port: Number(databaseUrl.port) || 5432,
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: 'pravshi-bootstrap',
  };
}

/** An error carrying a SQLSTATE came from the server; anything else means it never answered. */
const answeredByServer = (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code);

/**
 * Performs the bootstrap and hands the link to `deliver`, which is the only place the token
 * goes. Returns identifiers only.
 *
 * The link is delivered after COMMIT succeeds. If the COMMIT itself goes unanswered, the
 * outcome is genuinely unknown, and the link is delivered anyway, marked as such: withholding
 * it would leave a database that may be bootstrapped with no way to claim it. A second run
 * settles the question — the database refuses it if the first one took effect.
 */
export async function runBootstrap(config, { deliver, Client = pg.Client }) {
  const token = generateSetupToken();
  const digest = hashSetupToken(token);
  const link = setupLinkFor(config.appOrigin, token);

  const client = new Client(clientConfig(config.databaseUrl));
  await client.connect();
  try {
    const who = await client.query('select session_user::text as role');
    if (who.rows[0]?.role !== 'app_admin') {
      throw new Error('bootstrap refused: the connection is not authenticated as app_admin');
    }

    await client.query('begin');
    let row;
    try {
      const result = await client.query(
        `select organization_id, owner_person_id, owner_engagement_id, setup_token_expires_at
         from public.bootstrap_organization($1, $2, $3, $4, decode($5, 'hex'))`,
        [config.orgName, config.orgSlug, config.ownerName, config.ownerEmail, digest],
      );
      row = result.rows[0];
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    }

    try {
      await client.query('commit');
    } catch (e) {
      if (!answeredByServer(e)) {
        deliver({ link, expiresAt: row.setup_token_expires_at, committed: 'unknown' });
      }
      throw e;
    }

    deliver({ link, expiresAt: row.setup_token_expires_at, committed: true });
    return {
      organizationId: row.organization_id,
      ownerPersonId: row.owner_person_id,
      ownerEngagementId: row.owner_engagement_id,
      expiresAt: row.setup_token_expires_at,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------- main

function printLink({ link, expiresAt, committed }) {
  if (committed === true) {
    console.log('\nBootstrap committed. One-time setup link — shown once, stored nowhere:\n');
  } else {
    console.log('\nThe COMMIT was not acknowledged, so whether bootstrap took effect is UNKNOWN.');
    console.log('Run this command again: if the database says it is already bootstrapped, the');
    console.log('link below is live. If the second run succeeds instead, this link is void.\n');
  }
  console.log(`  ${link}\n`);
  console.log(`It expires at ${new Date(expiresAt).toISOString()} and cannot be re-issued.`);
  console.log('Open it on a trusted machine. Never paste it into chat, a ticket or a log.');
}

async function main() {
  const fileEnv = existsSync(ENV_PATH) ? loadEnv(ENV_PATH) : new Map();
  const settings = settingsFrom(process.env, fileEnv);
  if (settings.DATABASE_URL_BOOTSTRAP) {
    installOutputRedaction(redactorFor(settings.DATABASE_URL_BOOTSTRAP));
  }

  const config = readBootstrapConfig(settings);
  // Checked before connecting, so a refusal can never follow a bootstrap it cannot deliver.
  if (!process.stdout.isTTY) {
    throw new Error(
      'bootstrap refused: the one-time setup link is printed once, to an interactive terminal; ' +
        'stdout is not a terminal (redirected, piped or captured)',
    );
  }

  console.log('bootstrapping the first organization and SUPER_ADMIN ...');
  const result = await runBootstrap(config, { deliver: printLink });
  console.log(`\norganization ${result.organizationId}, owner ${result.ownerPersonId}`);
}

function reportAndExit(error) {
  console.error('FAILED');
  for (const field of ['message', 'code', 'detail', 'hint']) {
    const value = error?.[field];
    if (value !== undefined && value !== null && value !== '')
      console.error(`  ${field}: ${value}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('uncaughtException', reportAndExit);
  process.on('unhandledRejection', reportAndExit);
  await main().catch(reportAndExit);
}
