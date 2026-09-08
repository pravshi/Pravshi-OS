#!/usr/bin/env node
// PRAVSHI OS — workflow secret-flow guard (Task 11, finding #2).
//
// PURPOSE: prevent a GitHub Actions workflow from populating a DATABASE_URL* environment
// variable from a GitHub secret. CI must derive database URLs at runtime from the Neon
// API, so a database URL held as a long-lived Actions secret is a policy violation.
//
// THIS IS A HEURISTIC, NOT DATA-FLOW ANALYSIS. It parses the workflow YAML and tracks a
// taint set across env keys and step outputs. It catches direct binding, renaming through
// intermediate variables, step outputs derived from secrets, and shell `export`/assignment
// indirection that is visible in the run script. It cannot follow a value through an
// external action, a file, base64, or a dynamically constructed name. Treat a pass as
// "no obvious flow", never as proof.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';

const TARGET = /^DATABASE_URL/i;
const SECRETS_REF = /\$\{\{\s*secrets\./;
const ENV_REF = /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const OUT_REF = /\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/g;
const SHELL_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/**
 * @returns {{file:string, where:string, name:string, reason:string}[]} violations
 */
export function analyseWorkflow(doc, file = 'workflow') {
  const violations = [];
  const tainted = new Set(); // env var names whose value can carry a secret
  const taintedOutputs = new Set(); // "stepId.outputName"

  const valueIsTainted = (raw) => {
    const v = String(raw ?? '');
    if (SECRETS_REF.test(v)) return 'a GitHub secret';
    for (const m of v.matchAll(ENV_REF)) if (tainted.has(m[1])) return `env.${m[1]}`;
    for (const m of v.matchAll(OUT_REF)) {
      if (taintedOutputs.has(`${m[1]}.${m[2]}`)) return `steps.${m[1]}.outputs.${m[2]}`;
    }
    return null;
  };

  const scanEnvBlock = (env, where) => {
    for (const [name, raw] of Object.entries(env ?? {})) {
      const why = valueIsTainted(raw);
      if (why) {
        tainted.add(name);
        if (TARGET.test(name)) {
          violations.push({ file, where, name, reason: `${name} is populated from ${why}` });
        }
      }
    }
  };

  scanEnvBlock(doc?.env, 'workflow env');

  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    scanEnvBlock(job?.env, `job ${jobId} env`);

    for (const [i, step] of (job?.steps ?? []).entries()) {
      const where = `job ${jobId} step ${i + 1}${step?.name ? ` (${step.name})` : ''}`;
      scanEnvBlock(step?.env, where);

      // A step whose env is tainted may write that value into its outputs.
      const stepEnvTainted = Object.entries(step?.env ?? {}).some(([, v]) => valueIsTainted(v));
      const run = String(step?.run ?? '');

      if (step?.id && (stepEnvTainted || SECRETS_REF.test(run))) {
        for (const m of run.matchAll(/([A-Za-z0-9_-]+)\s*=.*>>\s*"?\$GITHUB_OUTPUT/g)) {
          taintedOutputs.add(`${step.id}.${m[1]}`);
        }
        // A script that emits outputs opaquely: treat every declared output as tainted.
        if (/GITHUB_OUTPUT/.test(run) === false && stepEnvTainted)
          taintedOutputs.add(`${step.id}.*`);
      }

      // Shell indirection: NAME=... / export NAME=... inside a run block.
      for (const m of run.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
        const [, name, rhs] = m;
        let why = valueIsTainted(rhs);
        if (!why) {
          for (const r of rhs.matchAll(SHELL_REF)) {
            if (tainted.has(r[1])) {
              why = `$${r[1]}`;
              break;
            }
          }
        }
        if (why) {
          tainted.add(name);
          if (TARGET.test(name)) {
            violations.push({
              file,
              where: `${where} (shell)`,
              name,
              reason: `${name} is assigned from ${why}`,
            });
          }
        }
      }
    }
  }
  return violations;
}

function main() {
  const dir = '.github/workflows';
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    console.log('workflow-secret-flow: no .github/workflows directory');
    return;
  }
  let total = 0;
  for (const f of files) {
    const path = join(dir, f);
    const violations = analyseWorkflow(parse(readFileSync(path, 'utf8')), path);
    for (const v of violations) {
      console.error(`  ${v.file} :: ${v.where}`);
      console.error(`    ${v.reason}`);
      total++;
    }
  }
  if (total > 0) {
    console.error(
      `\nworkflow-secret-flow: ${total} violation(s). CI must derive database URLs from the ` +
        'Neon API at runtime, never hold them as GitHub secrets.',
    );
    process.exit(1);
  }
  console.log(`workflow-secret-flow: clean (${files.length} workflow file(s), heuristic scan)`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) main();
