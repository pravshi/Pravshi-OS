'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTime } from '@/components/crm/format';
import { EmptyState } from '@/components/crm/empty-state';
import {
  createSubscription,
  deleteSubscription,
  IntegrationsApiError,
  revealSecret,
  rotateSubscriptionSecret,
  toggleEventSelection,
  updateSubscription,
  type RevealedSecret,
  type WebhookSubscriptionPageWire,
  type WebhookSubscriptionWire,
} from './integrations-client';

/**
 * SubscriptionsSection — outbound webhook subscriptions (Phase 10,
 * Wave G; contract §4.5/§4.8).
 *
 * Create generates the signing secret SERVER-side; the plaintext comes
 * back once and goes straight into the one-time reveal — after
 * dismissal it exists only as a vault envelope. Rotate replaces the
 * secret immediately (receivers must be given the new one first). The
 * active toggle is the per-subscription kill switch (§4.7). Delete is a
 * hard delete behind an inline confirm.
 *
 * Vault honesty: without INTEGRATIONS_ENCRYPTION_KEY there is nowhere
 * safe to keep a signing secret, so create/rotate are replaced by the
 * not-configured explanation (§4.8) — the API answers the same state
 * as a typed 503.
 */

function errorMessage(error: unknown): string {
  if (error instanceof IntegrationsApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

function SubscriptionRow({
  subscription,
  canManage,
  vaultConfigured,
  onChanged,
  onReveal,
}: {
  subscription: WebhookSubscriptionWire;
  canManage: boolean;
  vaultConfigured: boolean;
  onChanged: () => Promise<void>;
  onReveal: (revealed: RevealedSecret) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{subscription.url}</code>
        <Badge variant={subscription.active ? 'default' : 'secondary'}>
          {subscription.active ? 'Active' : 'Paused'}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {subscription.events.map((eventKey) => (
          <Badge key={eventKey} variant="outline">
            {eventKey}
          </Badge>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Created {formatDateTime(subscription.createdAt)} · signing secret{' '}
        {subscription.hasSigningSecret ? 'stored encrypted' : 'not set'}
      </p>
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={subscription.active}
              disabled={busy}
              onChange={(e) => {
                const active = e.target.checked;
                void run(async () => {
                  await updateSubscription(subscription.id, { active });
                  toast.success(active ? 'Subscription resumed.' : 'Subscription paused.');
                  await onChanged();
                });
              }}
              className="size-4 accent-primary"
            />
            Deliver events
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !vaultConfigured}
            onClick={() =>
              void run(async () => {
                const rotated = await rotateSubscriptionSecret(subscription.id);
                onReveal(
                  revealSecret(
                    'New signing secret',
                    rotated.signingSecret,
                    'Update your receiver now — the previous secret stopped working the moment this one was generated.',
                  ),
                );
                await onChanged();
              })
            }
          >
            Rotate secret
          </Button>
          {confirmingDelete ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await deleteSubscription(subscription.id);
                    toast.success('Subscription deleted.');
                    setConfirmingDelete(false);
                    await onChanged();
                  })
                }
              >
                Confirm delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Keep it
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SubscriptionsSection({
  subscriptions,
  eventKeys,
  vaultConfigured,
  canManage,
  onChanged,
  onReveal,
}: {
  subscriptions: WebhookSubscriptionPageWire;
  eventKeys: readonly string[];
  vaultConfigured: boolean;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onReveal: (revealed: RevealedSecret) => void;
}) {
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submitCreate = async () => {
    setBusy(true);
    try {
      const created = await createSubscription({ url: url.trim(), events: selectedEvents });
      onReveal(
        revealSecret(
          'Signing secret',
          created.signingSecret,
          'Your receiver verifies each delivery with HMAC-SHA256 over the raw body using this secret.',
        ),
      );
      toast.success('Subscription created.');
      setUrl('');
      setSelectedEvents([]);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Webhook subscriptions</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Send Pravshi OS events to your own endpoints, HMAC-signed. Deliveries run through the job
          queue with retries — see the execution history below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subscriptions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {subscriptions.rows.length === 0 ? (
            <EmptyState
              title="No subscriptions yet"
              description="Create one to start receiving signed event deliveries."
            />
          ) : (
            subscriptions.rows.map((subscription) => (
              <SubscriptionRow
                key={subscription.id}
                subscription={subscription}
                canManage={canManage}
                vaultConfigured={vaultConfigured}
                onChanged={onChanged}
                onReveal={onReveal}
              />
            ))
          )}

          {canManage &&
            (vaultConfigured ? (
              <form
                className="space-y-3 rounded-lg border border-line px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitCreate();
                }}
              >
                <p className="text-sm font-medium">New subscription</p>
                <div className="space-y-1.5">
                  <Label htmlFor="sub-url">Endpoint URL</Label>
                  <Input
                    id="sub-url"
                    type="url"
                    value={url}
                    placeholder="https://example.com/webhooks/pravshi"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Events</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {eventKeys.map((eventKey) => (
                      <label key={eventKey} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedEvents.includes(eventKey)}
                          onChange={(e) =>
                            setSelectedEvents((selected) =>
                              toggleEventSelection(selected, eventKey, e.target.checked),
                            )
                          }
                          className="size-4 accent-primary"
                        />
                        {eventKey}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || url.trim().length === 0 || selectedEvents.length === 0}
                >
                  Create subscription
                </Button>
              </form>
            ) : (
              <div className="rounded-lg border border-line px-4 py-3">
                <p className="text-sm font-medium">Signing secrets are not configured</p>
                <p className="mt-0.5 text-sm text-ink-muted">
                  The server vault key (INTEGRATIONS_ENCRYPTION_KEY) is not set, so there is nowhere
                  safe to store a subscription signing secret. Ask your administrator to configure
                  it, then subscriptions can be created and rotated.
                </p>
              </div>
            ))}
        </CardContent>
      </Card>
    </section>
  );
}
