/**
 * ESM resolve hook for `pnpm worker`.
 *
 * Node's native TypeScript support strips types but does NOT resolve
 * extensionless imports to `.ts` files, and it knows nothing of the `@/`
 * tsconfig path alias (`@/*` -> `./src/*`). This hook fills both gaps so the
 * worker's import graph loads without tsx/ts-node:
 *
 * 1. `@/...` specifiers are mapped into `./src/...` (`@/worker/...` into `./apps/worker/src/...`).
 * 2. Relative/absolute specifiers that do not name an existing file are
 *    probed with TypeScript extensions (`.ts`, `.tsx`, `/index.ts`).
 *
 * Registered by worker-loader.mjs (which runs via `node --import`).
 * Plain JavaScript on purpose — see worker-loader.mjs.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Workspace layout (redesign Step 7): shared code stays in ./src until Step 8, and the worker's
// own modules live in apps/worker/src, reached as `@/worker/...` (tsconfig.json paths).
const SRC_DIR = path.join(REPO_ROOT, 'src');
const WORKER_DIR = path.join(REPO_ROOT, 'apps', 'worker', 'src');
const DATABASE_DIR = path.join(REPO_ROOT, 'packages', 'database', 'src');
const OBSERVABILITY_DIR = path.join(REPO_ROOT, 'packages', 'observability', 'src');
const SECURITY_DIR = path.join(REPO_ROOT, 'packages', 'security', 'src');
const PLATFORM_CORE_DIR = path.join(REPO_ROOT, 'packages', 'platform-core', 'src');
const SHARED_SERVICES_DIR = path.join(REPO_ROOT, 'packages', 'shared-services', 'src');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'packages', 'contracts', 'src');
const CRM_CORE_DIR = path.join(REPO_ROOT, 'packages', 'crm-core', 'src');
const WORK_DIR = path.join(REPO_ROOT, 'packages', 'work', 'src');
const INTEGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'integrations', 'src');
const AUTOMATION_DIR = path.join(REPO_ROOT, 'packages', 'automation', 'src');
const IMPORTS_DIR = path.join(REPO_ROOT, 'packages', 'imports', 'src');
const SEARCH_DIR = path.join(REPO_ROOT, 'packages', 'search', 'src');

const TS_PROBES = ['.ts', '.tsx', '/index.ts'];

/** Return the file URL if `base` resolves to a real file, else null. */
function probe(base) {
  if (existsSync(base)) {
    try {
      if (!statSync(base).isDirectory()) {
        return pathToFileURL(base).href;
      }
    } catch {
      return null;
    }
  }
  for (const ext of TS_PROBES) {
    const candidate = base + ext;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 1. The `@/` tsconfig path alias.
  if (specifier === '@' || specifier.startsWith('@/')) {
    const relative = specifier === '@' ? '' : specifier.slice(2);
    let targetBase;
    if (relative.startsWith('worker/')) {
      targetBase = path.join(WORKER_DIR, relative.slice('worker/'.length));
    } else if (relative.startsWith('lib/db/')) {
      targetBase = path.join(DATABASE_DIR, relative.slice('lib/db/'.length));
    } else if (relative.startsWith('lib/observability/')) {
      targetBase = path.join(OBSERVABILITY_DIR, relative.slice('lib/observability/'.length));
    } else if (relative.startsWith('lib/audit/')) {
      targetBase = path.join(SECURITY_DIR, 'audit', relative.slice('lib/audit/'.length));
    } else if (relative.startsWith('lib/auth/')) {
      targetBase = path.join(SECURITY_DIR, 'auth', relative.slice('lib/auth/'.length));
    } else if (relative.startsWith('lib/authz/')) {
      targetBase = path.join(SECURITY_DIR, 'authz', relative.slice('lib/authz/'.length));
    } else if (relative.startsWith('lib/identity/')) {
      targetBase = path.join(SECURITY_DIR, 'identity', relative.slice('lib/identity/'.length));
    } else if (relative.startsWith('lib/platform/')) {
      targetBase = path.join(PLATFORM_CORE_DIR, relative.slice('lib/platform/'.length));
    } else if (relative.startsWith('lib/jobs/')) {
      targetBase = path.join(SHARED_SERVICES_DIR, 'jobs', relative.slice('lib/jobs/'.length));
    } else if (relative.startsWith('lib/notifications/')) {
      targetBase = path.join(
        SHARED_SERVICES_DIR,
        'notifications',
        relative.slice('lib/notifications/'.length),
      );
    } else if (relative === 'lib/events' || relative.startsWith('lib/events/')) {
      targetBase =
        relative === 'lib/events'
          ? path.join(SHARED_SERVICES_DIR, 'events', 'index')
          : path.join(SHARED_SERVICES_DIR, 'events', relative.slice('lib/events/'.length));
    } else if (relative.startsWith('lib/crm/')) {
      targetBase = path.join(CRM_CORE_DIR, relative.slice('lib/crm/'.length));
    } else if (relative.startsWith('lib/work/')) {
      targetBase = path.join(WORK_DIR, relative.slice('lib/work/'.length));
    } else if (relative.startsWith('lib/integrations/')) {
      targetBase = path.join(INTEGRATIONS_DIR, relative.slice('lib/integrations/'.length));
    } else if (relative.startsWith('lib/workflows/')) {
      targetBase = path.join(AUTOMATION_DIR, relative.slice('lib/workflows/'.length));
    } else if (relative.startsWith('lib/import/')) {
      targetBase = path.join(IMPORTS_DIR, relative.slice('lib/import/'.length));
    } else if (relative.startsWith('lib/search/')) {
      targetBase = path.join(SEARCH_DIR, relative.slice('lib/search/'.length));
    } else {
      targetBase = path.join(SRC_DIR, relative);
    }
    const url = probe(targetBase);
    if (url) return { url, shortCircuit: true };
    // Fall through so the error mentions the original `@/...` specifier.
    return nextResolve(specifier, context);
  }

  // 1b. The `@pravshi/database` package alias.
  if (specifier === '@pravshi/database' || specifier.startsWith('@pravshi/database/')) {
    const sub =
      specifier === '@pravshi/database' ? 'index.ts' : specifier.slice('@pravshi/database/'.length);
    const url = probe(path.join(DATABASE_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1c. The `@pravshi/observability` package alias.
  if (specifier === '@pravshi/observability' || specifier.startsWith('@pravshi/observability/')) {
    const sub =
      specifier === '@pravshi/observability'
        ? 'index.ts'
        : specifier.slice('@pravshi/observability/'.length);
    const url = probe(path.join(OBSERVABILITY_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1d. The `@pravshi/security` package alias.
  if (specifier === '@pravshi/security' || specifier.startsWith('@pravshi/security/')) {
    const sub =
      specifier === '@pravshi/security' ? 'index.ts' : specifier.slice('@pravshi/security/'.length);
    const url = probe(path.join(SECURITY_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1e. The `@pravshi/platform-core` package alias.
  if (specifier === '@pravshi/platform-core' || specifier.startsWith('@pravshi/platform-core/')) {
    const sub =
      specifier === '@pravshi/platform-core'
        ? 'index.ts'
        : specifier.slice('@pravshi/platform-core/'.length);
    const url = probe(path.join(PLATFORM_CORE_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1f. The `@pravshi/shared-services` package alias.
  if (
    specifier === '@pravshi/shared-services' ||
    specifier.startsWith('@pravshi/shared-services/')
  ) {
    const sub =
      specifier === '@pravshi/shared-services'
        ? 'index.ts'
        : specifier.slice('@pravshi/shared-services/'.length);
    const url = probe(path.join(SHARED_SERVICES_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1g. The `@pravshi/contracts` package alias.
  if (specifier === '@pravshi/contracts' || specifier.startsWith('@pravshi/contracts/')) {
    const sub =
      specifier === '@pravshi/contracts'
        ? 'index.ts'
        : specifier.slice('@pravshi/contracts/'.length);
    const url = probe(path.join(CONTRACTS_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1h. The `@pravshi/crm-core` package alias.
  if (specifier === '@pravshi/crm-core' || specifier.startsWith('@pravshi/crm-core/')) {
    const sub =
      specifier === '@pravshi/crm-core' ? 'index.ts' : specifier.slice('@pravshi/crm-core/'.length);
    const url = probe(path.join(CRM_CORE_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1i. The `@pravshi/work` package alias.
  if (specifier === '@pravshi/work' || specifier.startsWith('@pravshi/work/')) {
    const sub =
      specifier === '@pravshi/work' ? 'index.ts' : specifier.slice('@pravshi/work/'.length);
    const url = probe(path.join(WORK_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1j. The `@pravshi/integrations` package alias.
  if (specifier === '@pravshi/integrations' || specifier.startsWith('@pravshi/integrations/')) {
    const sub =
      specifier === '@pravshi/integrations'
        ? 'index.ts'
        : specifier.slice('@pravshi/integrations/'.length);
    const url = probe(path.join(INTEGRATIONS_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1k. The `@pravshi/automation` package alias.
  if (specifier === '@pravshi/automation' || specifier.startsWith('@pravshi/automation/')) {
    const sub =
      specifier === '@pravshi/automation'
        ? 'index.ts'
        : specifier.slice('@pravshi/automation/'.length);
    const url = probe(path.join(AUTOMATION_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1l. The `@pravshi/imports` package alias.
  if (specifier === '@pravshi/imports' || specifier.startsWith('@pravshi/imports/')) {
    const sub =
      specifier === '@pravshi/imports' ? 'index.ts' : specifier.slice('@pravshi/imports/'.length);
    const url = probe(path.join(IMPORTS_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 1m. The `@pravshi/search` package alias.
  if (specifier === '@pravshi/search' || specifier.startsWith('@pravshi/search/')) {
    const sub =
      specifier === '@pravshi/search' ? 'index.ts' : specifier.slice('@pravshi/search/'.length);
    const url = probe(path.join(SEARCH_DIR, sub));
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 2. Extensionless relative/absolute imports inside the TS sources.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) &&
    context.parentURL?.startsWith('file:')
  ) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    const url = probe(base);
    if (url) return { url, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
