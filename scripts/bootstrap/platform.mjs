#!/usr/bin/env node
// PRAVSHI OS — the platform operator's commands (ADR-008, migration 0083).
//
// Usage:
//   node scripts/bootstrap/platform.mjs first-admin   --email <e> --name "<full name>"
//   node scripts/bootstrap/platform.mjs reissue-setup --email <e>
//   node scripts/bootstrap/platform.mjs recover       --email <e> --reason "<10-500 characters>"
//
//   first-admin    Creates the first platform administrator with every platform permission and
//                  a 60-minute setup link. Once per database: the database refuses every later
//                  attempt, whoever makes it.
//   reissue-setup  A new 60-minute link for an administrator who has not completed setup; the
//                  previous link stops working.
//   recover        Break-glass, for an ACTIVE administrator who lost their password or second
//                  factor: ends their sessions, removes their factor and password, returns them
//                  to setup, and prints a 60-minute link. Their old credentials stop working at
//                  once. Audited as BREAK_GLASS with the reason.
//
// Settings, from the process environment first, then .env (as scripts/bootstrap/run.mjs):
//   DATABASE_URL_BOOTSTRAP   app_admin, DIRECT endpoint. Operator machine only.
//   APP_URL                  where the setup link points (https, or http for localhost)
//
// The setup token is made, hashed and printed exactly as by run.mjs: 32 CSPRNG bytes, only the
// SHA-256 digest reaches the database, the link (a URL fragment) is printed once to an
// interactive terminal and stored nowhere. Never in CI. Every byte printed is redacted against
// the database URL.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { installOutputRedaction, loadEnv } from '../db/run.mjs';
import { generateSetupToken, hashSetupToken, redactorFor } from './run.mjs';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const COMMANDS = ['first-admin', 'reissue-setup', 'recover'];

/** /platform/setup#token=… — a fragment, never sent to a server or in a Referer. */
export function platformSetupLinkFor(appOrigin, token) {
  const link = new URL('/platform/setup', appOrigin);
  link.hash = `token=${token}`;
  return link.toString();
}

/**
 * --flag value pairs; anything else is refused.
 * @param {string[]} argv
 * @returns {{ command: string | undefined, flags: Record<string, string> }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!/^--(email|name|reason)$/.test(key ?? '') || value === undefined) {
      throw new Error(`platform: unexpected argument ${JSON.stringify(key ?? '')}`);
    }
    flags[key.slice(2)] = value;
  }
  return { command, flags };
}

/**
 * Validates everything before a database is touched. Problems name a setting, never its value.
 * @param {{command?: string, flags: Record<string, string>}} args
 * @param {Record<string, string>} settings DATABASE_URL_BOOTSTRAP and APP_URL
 * @param {Record<string, string | undefined>} [processEnv]
 */
export function readOperatorConfig(args, settings, processEnv = process.env) {
  const problems = [];
  if (processEnv.CI || processEnv.GITHUB_ACTIONS) {
    problems.push('platform operations never run in CI (CI or GITHUB_ACTIONS is set)');
  }
  if (!COMMANDS.includes(args.command ?? '')) {
    problems.push(`the command must be one of: ${COMMANDS.join(', ')}`);
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
      problems.push('DATABASE_URL_BOOTSTRAP must connect as the operator role, app_admin');
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

  const { email, name, reason } = args.flags;
  if (!EMAIL.test(email ?? '')) problems.push('--email is required and must be a valid address');
  if (args.command === 'first-admin' && !(name ?? '').trim()) {
    problems.push('--name is required for first-admin');
  }
  if (args.command === 'recover') {
    const r = (reason ?? '').trim();
    if (r.length < 10 || r.length > 500)
      problems.push('--reason (10-500 characters) is required for recover');
  }
  if (args.command !== 'first-admin' && name !== undefined)
    problems.push('--name is only for first-admin');
  if (args.command !== 'recover' && reason !== undefined)
    problems.push('--reason is only for recover');

  if (problems.length > 0) {
    throw new Error(`platform refused:\n  - ${problems.join('\n  - ')}`);
  }
  return {
    command: args.command,
    databaseUrl,
    appOrigin,
    email: email.trim(),
    name: name?.trim() ?? null,
    reason: reason?.trim() ?? null,
  };
}

function clientConfig(databaseUrl) {
  const host = databaseUrl.hostname;
  return {
    host,
    port: Number(databaseUrl.port) || 5432,
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: 'pravshi-platform-operator',
  };
}

const answeredByServer = (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code);

const STATEMENTS = {
  'first-admin': (c) => [
    `select setup_expires_at as expires_at
     from platform.bootstrap_first_admin($1, $2, decode($3, 'hex'))`,
    [c.email, c.name],
  ],
  'reissue-setup': (c) => [
    `select platform.reissue_setup($1, decode($2, 'hex')) as expires_at`,
    [c.email],
  ],
  recover: (c) => [
    `select platform.recover_admin($1, $2, decode($3, 'hex')) as expires_at`,
    [c.email, c.reason],
  ],
};

/**
 * Runs one operator command and hands the link to `deliver` — the only place the token goes —
 * after COMMIT (or, if the COMMIT goes unanswered, marked unknown, as run.mjs does).
 */
export async function runPlatformOperation(config, { deliver, Client = pg.Client }) {
  const token = generateSetupToken();
  const digest = hashSetupToken(token);
  const link = platformSetupLinkFor(config.appOrigin, token);
  const [text, params] = STATEMENTS[config.command](config);

  const client = new Client(clientConfig(config.databaseUrl));
  await client.connect();
  try {
    const who = await client.query('select session_user::text as role');
    if (who.rows[0]?.role !== 'app_admin') {
      throw new Error('platform refused: the connection is not authenticated as app_admin');
    }
    await client.query('begin');
    let expiresAt;
    try {
      const result = await client.query(text, [...params, digest]);
      expiresAt = result.rows[0]?.expires_at;
      if (!expiresAt) throw new Error('platform: the database returned no expiry');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    }
    try {
      await client.query('commit');
    } catch (e) {
      if (!answeredByServer(e)) deliver({ link, expiresAt, committed: 'unknown' });
      throw e;
    }
    deliver({ link, expiresAt, committed: true });
    return { expiresAt };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function printLink({ link, expiresAt, committed }) {
  if (committed === true) {
    console.log('\nDone. One-time setup link — shown once, stored nowhere:\n');
  } else {
    console.log('\nThe COMMIT was not acknowledged, so whether this took effect is UNKNOWN.');
    console.log(
      'Check the platform audit before running it again; a re-issue makes this link void.\n',
    );
  }
  console.log(`  ${link}\n`);
  console.log(`It expires at ${new Date(expiresAt).toISOString()}.`);
  console.log('Give it to the administrator by a channel you trust. Never paste it into chat, a');
  console.log('ticket or a log. After setup they sign in and enrol two-factor authentication.');
}

async function main() {
  const fileEnv = existsSync(ENV_PATH) ? loadEnv(ENV_PATH) : new Map();
  const settings = {};
  for (const key of ['DATABASE_URL_BOOTSTRAP', 'APP_URL']) {
    settings[key] = (process.env[key] || fileEnv.get(key) || '').trim();
  }
  if (settings.DATABASE_URL_BOOTSTRAP) {
    installOutputRedaction(redactorFor(settings.DATABASE_URL_BOOTSTRAP));
  }
  const config = readOperatorConfig(parseArgs(process.argv.slice(2)), settings);
  if (!process.stdout.isTTY) {
    throw new Error(
      'platform refused: the one-time setup link is printed once, to an interactive terminal; ' +
        'stdout is not a terminal (redirected, piped or captured)',
    );
  }
  console.log(`platform ${config.command} ...`);
  await runPlatformOperation(config, { deliver: printLink });
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
