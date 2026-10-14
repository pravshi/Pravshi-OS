# WP-A1 auth pool probe — run record (design §6.2)

**Status until filled in: BLOCKED — OPERATOR VERIFICATION REQUIRED.** The authentication pool's
size (`AUTH_POOL_MAX = 3` per web instance, next to the business pool's 5) is provisional until a
run against a real Neon pooler is recorded here. CI and local runs go through a local proxy and say
nothing about Neon's pooler.

Rules: an **isolated non-production** Neon project or dev branch only — never production. No paid
feature, no plan change. Credentials stay in the operator's shell; nothing below records one.

## 0. Target

| Item                                                      | Value |
| --------------------------------------------------------- | ----- |
| Date / operator                                           |       |
| Neon project / branch (non-production)                    |       |
| Compute size (console)                                    |       |
| Commit of the app under test                              |       |
| Approval for this run (who, when)                         |       |
| Neon docs consulted for pooler limits (URL + access date) |       |

## 1–3. Probe output

Run, from a local checkout, with the four URLs of that branch in the environment:

```bash
node scripts/ops/auth-pool-probe.mjs --non-production-branch <branch> --instances 1,3,10 --seconds 60
```

Paste the JSON it prints (it contains hosts, never credentials). Exit code 0 means every pooled
URL answered with its own role.

```json

```

## 4. Acceptance (expected peak: 3 instances; stress: 10)

| Check                                                                      | 3 instances | 10 instances |
| -------------------------------------------------------------------------- | ----------- | ------------ |
| `identity`: app_user / app_auth / app_worker each answered as itself       |             |              |
| No client errors (`errors` empty for both roles)                           |             |              |
| Peak app_auth server connections ≤ documented per-role pool size           |             |              |
| Peak total server connections < `max_connections` − `reserved`            |             |              |
| app_auth p95 acquire ≤ single-instance p95 + 200 ms                        |             |              |

If a check fails at 3 instances: lower `AUTH_POOL_MAX` to 2 and repeat, or record the limit as a
deployment constraint. A failure only at 10 instances is recorded as the stress ceiling.

## 5. Compute hours (Neon console, 24 h)

| Period                                    | Compute hours | Notes |
| ----------------------------------------- | ------------- | ----- |
| 24 h before the new build, idle           |               |       |
| 24 h after the new build, idle            |               |       |

Expected: no measurable change (the authentication queries already existed; they only moved to
another login). Any increase is recorded and explained before merge.

## 6. Idle pools and auto-suspend (Neon console)

| Check                                                             | Result |
| ----------------------------------------------------------------- | ------ |
| After the probe ends, the compute suspends after its idle period  |        |
| Time from last query to suspend                                   |        |

## Outcome

- [ ] `AUTH_POOL_MAX = 3` confirmed, or changed to: \_\_\_ (with the reason)
- [ ] Gate closed by: \_\_\_ on \_\_\_
