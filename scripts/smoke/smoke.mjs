#!/usr/bin/env node
/**
 * Post-deployment smoke checks, items 1–3 of docs/runbooks/smoke-tests.md.
 *
 * Read-only GETs only. Takes BASE_URL and HEALTH_CHECK_TOKEN from the
 * environment — contains no credentials and stores nothing.
 *
 *   BASE_URL="https://<production-host>" HEALTH_CHECK_TOKEN="<from secret store>" \
 *     node scripts/smoke/smoke.mjs
 *
 * Exit code 0 when every expectation holds, 1 otherwise.
 */

const baseUrl = process.env.BASE_URL;
const token = process.env.HEALTH_CHECK_TOKEN;

if (!baseUrl) {
  console.error('FAIL  BASE_URL is not set');
  process.exit(1);
}
if (!token) {
  console.error('FAIL  HEALTH_CHECK_TOKEN is not set');
  process.exit(1);
}

const base = baseUrl.replace(/\/+$/, '');
let failures = 0;

function report(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body; callers judge by status/shape expectations.
  }
  return { status: res.status, json };
}

// 1. Liveness: GET /health → 200 {"status":"ok", ...}; touches nothing.
try {
  const { status, json } = await get('/health');
  report(
    status === 200 && json?.status === 'ok',
    '1. GET /health → 200 {status:"ok"}',
    `got ${status}`,
  );
} catch (e) {
  report(false, '1. GET /health → 200 {status:"ok"}', e.message);
}

// 2. Concealment: GET /health/db without the token → 404, DB never touched.
try {
  const { status } = await get('/health/db');
  report(status === 404, '2. GET /health/db unauthenticated → 404', `got ${status}`);
} catch (e) {
  report(false, '2. GET /health/db unauthenticated → 404', e.message);
}

// 3. Reachability: GET /health/db with the token → 200 {"status":"ok","wake_ms":N}.
try {
  const { status, json } = await get('/health/db', { 'x-pravshi-health-token': token });
  const ok = status === 200 && json?.status === 'ok' && typeof json?.wake_ms === 'number';
  report(
    ok,
    '3. GET /health/db with token → 200, wake_ms recorded',
    ok ? `wake_ms=${json.wake_ms}` : `got ${status}`,
  );
} catch (e) {
  report(false, '3. GET /health/db with token → 200, wake_ms recorded', e.message);
}

process.exit(failures === 0 ? 0 : 1);
