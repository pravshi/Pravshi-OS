# WP-A1 auth pool probe — run record (design §6.2)

**Status until filled in: BLOCKED — OPERATOR VERIFICATION REQUIRED.** The authentication pool's
size (`AUTH_POOL_MAX = 3` per web instance, next to the business pool's 5) is provisional until a
run against a real Neon pooler is recorded here. CI and local runs go through a local proxy and say
nothing about Neon's pooler; a `--local-dry-run` result is never evidence for this record.

Procedure: [auth-pool-probe.md](./auth-pool-probe.md). Rules: an **isolated non-production** Neon
project or dev branch only — never production. No paid feature, no plan change. This repository is
public: nothing below may hold a password, a connection string, a full hostname or an unmasked
endpoint ID. The probe's JSON is safe to paste as printed (it masks endpoint IDs).

## 0. Target

| Item                                                          | Value |
| ------------------------------------------------------------- | ----- |
| Date / operator                                               |       |
| Neon project (non-production) and branch                      |       |
| Endpoint ID, masked as the probe prints it (`ep-…xxxx`)       |       |
| Endpoint confirmed in the Neon console before the run (yes/no) |       |
| Compute size (console)                                        |       |
| Commit of the app under test                                  |       |
| Migrations applied to the branch (latest journal entry)       |       |
| Approval for this run (who, when)                             |       |
| Neon docs consulted for pooler limits (URL + access date)     |       |
| Documented per-role pooler limit used for the MANUAL check    |       |

## 1–3. Probe output

Command (procedure step 6), with the flags actually used:

```text
node --env-file=<outside the repo> scripts/ops/auth-pool-probe.mjs --non-production-branch <branch> --expect-endpoint <ep-id> --instances 1,3,10 --seconds 60
```

| Field                  | Value |
| ---------------------- | ----- |
| Exit code              |       |
| `status`               |       |
| `neon_pooler_verified` |       |
| `identity_status`      |       |
| `load_status`          |       |

Paste the JSON it printed (for a refused or interrupted run too):

```json

```

## 4. Acceptance (expected peak: 3 instances; stress: 10)

| Check (JSON field)                                                                    | 3 instances | 10 instances |
| ------------------------------------------------------------------------------------- | ----------- | ------------ |
| `identity`: app_user / app_auth / app_worker / app_owner each `ok: true`             |             |              |
| `checks.no_client_errors` = PASS (`errors` empty for both roles)                      |             |              |
| `checks.app_auth_peak_within_documented_pool_size` (MANUAL: peak app_auth ≤ limit)    |             |              |
| `checks.peak_total_below_max_minus_reserved` = PASS                                   |             |              |
| `checks.app_auth_p95_within_single_instance_plus_200ms` = PASS                        |             |              |

If a check fails at 3 instances: lower the authentication pool and repeat
(`--auth-per-instance 2 --instances 1,3`, record below), or record the limit as a deployment
constraint. A failure only at 10 instances is recorded as the stress ceiling (the run exits 1 with
`LOAD_FAILED`; that alone does not fail the gate).

### Retry (only if a 3-instance check failed)

| Item                               | Value |
| ---------------------------------- | ----- |
| Flags used                         |       |
| Exit code / `status`               |       |
| Result of each failed check, again |       |

## 5. Compute hours (Neon console)

| Period                                     | Compute hours | Notes |
| ------------------------------------------ | ------------- | ----- |
| The probe run itself                       |               |       |
| 24 h before the new build, idle            |               |       |
| 24 h after the new build, idle             |               |       |

The two 24-hour rows need a build deployed against this branch; when none is, write
**N/A — no deployment on this branch**. Where they apply, the expectation is no measurable change
(the authentication queries already existed; they only moved to another login), and any increase
is recorded and explained before merge.

## 6. Idle pools and auto-suspend (Neon console)

| Check                                                             | Result |
| ----------------------------------------------------------------- | ------ |
| After the probe ends, the compute suspends after its idle period  |        |
| Time from last query to suspend                                   |        |

## Outcome

- [ ] `AUTH_POOL_MAX = 3` confirmed, or changed to: \_\_\_ (with the reason)
- [ ] Gate closed by: \_\_\_ on \_\_\_
