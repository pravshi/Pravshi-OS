## What changed

## Does this change permissions, RLS policies, or database roles?

- [ ] No
- [ ] Yes — and these tests prove the new behaviour:

## Does this add anything that could keep Neon compute awake?

(cron, scheduled job, background worker, polled DB-backed endpoint)

- [ ] No
- [ ] Yes — and here is the founder decision authorising it:

## Verification

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally
- [ ] CI is green (required by engineering policy — GitHub Free cannot enforce this)
- [ ] Branch name matches the convention (`feature/` `fix/` `chore/` `docs/` `hotfix/`)
- [ ] No secret, connection string or credential appears in the diff
