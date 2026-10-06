/**
 * ESM resolve hook for `pnpm worker`.
 *
 * Node's native TypeScript support strips types but does NOT resolve
 * extensionless imports to `.ts` files, and it knows nothing of the `@/`
 * tsconfig path alias (`@/*` -> `./src/*`). This hook fills both gaps so the
 * worker's import graph loads without tsx/ts-node:
 *
 * 1. `@/...` specifiers are mapped into `./src/...`.
 * 2. Relative/absolute specifiers that do not name an existing file are
 *    probed with TypeScript extensions (`.ts`, `.tsx`, `/index.ts`).
 *
 * Registered by worker-loader.mjs (which runs via `node --import`).
 * Plain JavaScript on purpose — see worker-loader.mjs.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
    const url = probe(path.join(SRC_DIR, relative));
    if (url) return { url, shortCircuit: true };
    // Fall through so the error mentions the original `@/...` specifier.
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
