# Runbook: Incident response

One page, in order. Do not skip ahead: each step tells you whether the problem is the app,
the database, the async plane, or someone else's outage.

## Triage

1. **App up?** `GET https://os.pravshi.com/health` → expect 200 `{"status":"ok"}`. It is
   public and touches nothing. If it fails, the deployment/platform is the problem — check
   the Vercel deployment status before anything else.
2. **Database reachable?** `GET /health/db` with the `x-pravshi-health-token` header →
   expect 200 with `wake_ms`. A large first `wake_ms` is a cold start, not an incident.
   Note the value and **do not poll it** — each call wakes suspended compute. (Without the
   header it returns 404 by design; that is not a failure signal.)
3. **Errors spiking?** Sentry (once a DSN is issued, gate HG-6). Until then: the web app's
   platform logs and the worker's logs. Look for a deploy-correlated start time.
4. **Async plane backed up?** Check the jobs table:

   ```sql
   select status, count(*) from public.jobs group by status;
   select id, type, error_code, attempts, created_at
     from public.jobs where status = 'dead' order by created_at desc limit 20;
   ```

   A growing `pending` count with a live app usually means the worker is down or not
   claiming — verify with the two-part liveness check in
   [DEPLOYMENT.md](../../DEPLOYMENT.md) ("The worker plane"): supervisor says running,
   and claim heartbeats (`max(heartbeat_at)`) are fresh.

5. **Provider outage?** Neon status and Vercel status. If the incident is theirs, the job
   is communication and waiting — do not "fix" a provider outage with application changes.

## Contain — the kill switches that exist today

- **AI, per org:** set the org's AI limits `enabled` flag to `false`
  (`PUT /api/ai/usage/limits`, requires `ai.usage.manage`). AI requests for that org stop
  immediately; the rest of the product is unaffected.
- **Integrations:** disconnect the connection (Settings → Integrations). Disconnecting
  **destroys the stored credential** — that is the point; reconnecting means re-entering it.
- **Invitations:** revoke the invitation-creation grant from the affected roles. No new
  invitations can be issued until it is restored; existing users are unaffected.
- **Async plane, whole:** stop the worker process. Jobs, scheduled triggers, outbound
  webhooks and job email all halt; the web app keeps serving. Restarting the worker reaps
  stale claims and resumes the queue.

## Escalate

Everything production escalates to **Nani**. In particular, no agent or operator
improvises any of: a production migration or data change (forward-fix only, through the
[production migration runbook](production-migration.md) — never an improvised
down-migration), a credential rotation beyond the procedure in
[SECURITY.md](../../SECURITY.md), or a restore (see [backups.md](backups.md)).

## Post-incident record

Append one record per incident to the phase/release records, in this shape:

| Field        | Content |
| ------------ | ------- |
| Detected     | date/time (IST), and by whom or what |
| Impact       | who was affected, what stopped working, for how long |
| Root cause   | the mechanism, not the symptom |
| Timeline     | detection → containment → resolution, with times |
| Actions      | what was changed, in the product or in procedure |
| Follow-ups   | each with an owner; link the PR or gate that closes it |
