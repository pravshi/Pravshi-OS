-- PRAVSHI OS — Phase 10 (Wave W-out): worker-plane signing-secret resolution
-- for outbound webhook subscriptions.
--
-- PART 1 — public.integration_webhook_resolve_delivery(): the read the
--   `webhook` job handler uses at delivery time to resolve a subscription's
--   signing secret (contract §4.5 [DECISION]: the job payload carries only
--   the subscriptionId; the secret is resolved and decrypted INSIDE the
--   worker and never rides in jobs.payload, which operators can read).
--
-- WHY SECURITY DEFINER, AND WHY IT IS SAFE
--
-- The job worker runs as the nil-UUID system actor (jobs/worker.ts
-- buildJobAuthorization): it is not a row in people, so authz.has() is
-- false for it and the subscriptions SELECT policy (org match +
-- integrations.view, migration 0056) can never be satisfied on the worker
-- plane — the same wall the notification handler met, solved there with
-- the bounded definers notifications_insert() (0047) and
-- notifications_recipient_exists() (0052), and the shape Wave W-in reused
-- for the pre-auth inbound reads (0058). This function is that pattern,
-- kept as narrow as those:
--
--   - The org parameter is not a caller claim. The handler passes
--     ctx.job.orgId — stamped on the job row at enqueue time from the
--     authorized enqueueing context (the §3.6 actor authority rule) and
--     never read from the payload. A payload-supplied org id is not
--     accepted anywhere in the delivery path.
--   - The function returns, for the exact (org, subscription) pair only,
--     the row's active flag and its signing-secret CIPHERTEXT. The
--     plaintext exists nowhere in the database; decryption happens in the
--     worker with the env-held vault key (§4.3), so the ciphertext alone
--     is not a usable credential, and no other subscription, connection or
--     organization is reachable through any parameter value.
--   - active is returned (rather than filtering here) so the handler can
--     distinguish "no such subscription in this org" (zero rows →
--     NOT_FOUND) from "disabled after enqueue" (a row with active=false →
--     the delivery is dropped, not attempted).
--
-- No RLS or schema changes: the subscriptions table and its policies are
-- exactly as 0056 left them; this is a read path alongside them.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — worker-plane subscription delivery resolution
-- ═════════════════════════════════════════════════════════════════════════════════

create function public.integration_webhook_resolve_delivery(
  p_org_id uuid,
  p_subscription_id uuid
)
returns table (
  is_active boolean,
  signing_secret_ciphertext text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.active, s.signing_secret_ciphertext
  from public.integration_webhook_subscriptions s
  where s.org_id = p_org_id
    and s.id = p_subscription_id;
$$;

comment on function public.integration_webhook_resolve_delivery(uuid, uuid) is
  'Phase 10 (0059): worker-plane delivery resolution for one webhook '
  'subscription — its active flag and signing-secret ciphertext, for the '
  'exact (org, subscription) pair named by the job row. Narrow by design '
  '(the notifications_insert / 0058 precedent): exposes no plaintext (none '
  'exists in the DB) and nothing about any other row.';

revoke all on function public.integration_webhook_resolve_delivery(uuid, uuid) from public;
grant execute on function public.integration_webhook_resolve_delivery(uuid, uuid) to app_user;
