# Dependency advisory exceptions

`pnpm audit --audit-level=high` is a release gate. An advisory may be ignored only through
`auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` (a shared file: changing it needs the founder's
approval), and only when it is recorded here with its package, justification, owner and expiry.
An expired entry is a gate failure: renew it with fresh evidence, or remove the ignore and fix the
dependency.

As of 2026-11-08, `pnpm audit --audit-level=high` reports `3 low | 9 moderate | 1 high (1
ignored)`. The one ignored High is `GHSA-wq5f-xc86-pv6w` (sharp). This is an inference from the
evidence below, not a statement pnpm prints: `sharp@0.35.4` is in the lockfile and inside that
advisory's vulnerable range, while the other ignored advisory has been withdrawn by GitHub and
is therefore no longer reported.

| Advisory | Package | Severity | Where it enters | Justification | Owner | Expiry |
| --- | --- | --- | --- | --- | --- | --- |
| `GHSA-wq5f-xc86-pv6w` (CVE-2026-96889, librsvg) | `sharp` `<0.35.5` — installed `0.35.4` | High | Build time only: the peer of `minimizer-webpack-plugin` under `@sentry/webpack-plugin` (`@sentry/bundler-plugins`). The application's own `sharp`, through `next`, is `0.35.5`, which is patched. | The vulnerable copy runs only inside the production build, on trusted inputs (the repository's own assets); it is not part of the server runtime. Its peer range accepts any version, but an override does not move it (tried `sharp@>=0.35 <0.35.5` and `sharp`: still 0.35.4). Removing it needs a wider lockfile re-resolution, which is a dependency change requiring the founder's approval. Added in `75b3514` (2026-10-06). | Engineering lead (Claude Code); the founder approves any dependency change | **2026-12-08**, or earlier when `@sentry/webpack-plugin` or its minimizer resolves `sharp >= 0.35.5` |
| `GHSA-vfj7-8cjw-p6xm` | `braces` `<=3.0.3` — installed `3.0.3` | (withdrawn) | Tooling only: through `micromatch`/`fast-glob` from `eslint-config-next` and the shadcn CLI (`@shadcn/registry`, `ts-morph`). The application does not run it. | GitHub has withdrawn the advisory, and it has no patched release. Added in `a4a07cd` (2026-10-03). | Engineering lead (Claude Code) | **2026-12-08**: re-check that the advisory is still withdrawn; remove the ignore once `braces` resolves above 3.0.3 |

## Review procedure (at each expiry, or at any dependency change)

1. Run `pnpm audit --audit-level=high` and `pnpm audit --json`, and record the severity counts.
2. For each entry, confirm with `pnpm why <package>` that the vulnerable version is still present
   only on the path described.
3. Try the least invasive fix: an override in `pnpm-workspace.yaml`, or an upgrade of the
   consumer. Both are dependency changes and need the founder's approval.
4. Either remove the ignore, or renew the expiry here, with the evidence from steps 1–3.
