'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTime } from '@/components/crm/format';
import {
  buildCreateConnectionBody,
  buildUpdateConnectionBody,
  configFieldsForProvider,
  connectionStatusMeta,
  createConnection,
  disconnectConnection,
  IntegrationsApiError,
  issueInboundEndpoint,
  revealSecret,
  rotateConnectionSecret,
  updateConnection,
  type IntegrationConnectionWire,
  type IntegrationProviderWire,
  type RevealedSecret,
  type StatusTone,
} from './integrations-client';

/**
 * ConnectionsSection — the provider catalogue with this org's
 * connections (Phase 10, Wave G; contract §4.8).
 *
 * One card per registered provider: its connections with status chips
 * and health, connect/configure forms whose secret fields are
 * WRITE-ONLY password inputs (never repopulated — rotation is a
 * separate action with its own field), disconnect (= the DELETE route:
 * the credential is destroyed server-side before the row goes), and —
 * for providers with an inbound descriptor — endpoint issue/rotate,
 * whose URL is handed to the one-time reveal.
 *
 * Not-configured honesty (§4.8): when the deployment vault key is
 * unset, Tier V surfaces say so in plain text — a webhooks connection
 * can still be created (it needs no pasted secret), but subscription
 * signing secrets cannot be stored, and the subscriptions section
 * below explains the same state.
 *
 * Display gating only: every action calls an API that enforces
 * integrations.manage itself (§4.8); canManage merely hides controls.
 */

const TONE_VARIANT: Record<StatusTone, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  success: 'default',
  muted: 'secondary',
  warning: 'outline',
  danger: 'destructive',
};

function errorMessage(error: unknown): string {
  if (error instanceof IntegrationsApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

function ConfigFields({
  providerKey,
  values,
  onChange,
}: {
  providerKey: string;
  values: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const fields = configFieldsForProvider(providerKey);
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field) =>
        field.kind === 'checkbox' ? (
          <label key={field.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values[field.key] === true}
              onChange={(e) => onChange(field.key, e.target.checked)}
              className="size-4 accent-primary"
            />
            {field.label}
          </label>
        ) : (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={`${providerKey}-${field.key}`}>{field.label}</Label>
            <Input
              id={`${providerKey}-${field.key}`}
              type={field.kind}
              value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
              placeholder={field.placeholder}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          </div>
        ),
      )}
    </>
  );
}

function initialConfigValues(
  provider: IntegrationProviderWire,
  existing?: IntegrationConnectionWire,
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  const source = existing ? existing.config : provider.defaultConfig;
  for (const field of configFieldsForProvider(provider.key)) {
    const raw = source[field.key];
    values[field.key] =
      field.kind === 'checkbox' ? raw === true : typeof raw === 'string' ? raw : '';
  }
  return values;
}

function ConnectionBlock({
  provider,
  connection,
  canManage,
  vaultConfigured,
  onChanged,
  onReveal,
}: {
  provider: IntegrationProviderWire;
  connection: IntegrationConnectionWire;
  canManage: boolean;
  vaultConfigured: boolean;
  onChanged: () => Promise<void>;
  onReveal: (revealed: RevealedSecret) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'rotate'>('idle');
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(connection.displayName);
  const [configValues, setConfigValues] = useState(() => initialConfigValues(provider, connection));
  const [status, setStatus] = useState<'CONNECTED' | 'DISCONNECTED'>(
    connection.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'CONNECTED',
  );
  const [newSecret, setNewSecret] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const meta = connectionStatusMeta(connection.status);
  const fields = configFieldsForProvider(provider.key);

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

  const submitEdit = () =>
    run(async () => {
      const body = buildUpdateConnectionBody(connection, {
        displayName,
        configValues,
        secret: '',
      });
      const patch = {
        ...(body ?? {}),
        ...(status !== connection.status ? { status } : {}),
      };
      if (Object.keys(patch).length === 0) {
        toast.info('Nothing changed.');
        setMode('idle');
        return;
      }
      await updateConnection(connection.id, patch);
      toast.success('Connection updated.');
      setMode('idle');
      await onChanged();
    });

  const submitRotate = () =>
    run(async () => {
      if (newSecret.length === 0) {
        toast.error('Enter the replacement secret.');
        return;
      }
      await rotateConnectionSecret(connection.id, { secret: newSecret });
      setNewSecret('');
      toast.success('Secret rotated — the previous secret no longer works.');
      setMode('idle');
      await onChanged();
    });

  const submitDisconnect = () =>
    run(async () => {
      await disconnectConnection(connection.id);
      toast.success('Disconnected — the stored credential was destroyed.');
      setConfirmingDisconnect(false);
      await onChanged();
    });

  const submitIssueEndpoint = () =>
    run(async () => {
      const issued = await issueInboundEndpoint(connection.id);
      onReveal(
        revealSecret(
          'Inbound endpoint URL',
          issued.inboundUrl,
          'Give this URL to the external sender. Issuing again replaces it immediately — the old URL stops working.',
        ),
      );
    });

  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{connection.displayName}</p>
        <Badge variant={TONE_VARIANT[meta.tone]}>{meta.label}</Badge>
        {connection.hasCredential ? (
          <span className="text-xs text-ink-muted">
            {provider.credentialTier === 'env'
              ? `Credential: deployment env (${connection.maskedCredentialRef ?? 'referenced'})`
              : 'Credential: stored encrypted'}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">No credential stored</span>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {fields.map((field) => {
          const raw = connection.config[field.key];
          if (raw === undefined) return null;
          return (
            <div key={field.key} className="flex gap-2">
              <dt className="text-ink-muted">{field.label}:</dt>
              <dd>{typeof raw === 'boolean' ? (raw ? 'On' : 'Off') : String(raw)}</dd>
            </div>
          );
        })}
        <div className="flex gap-2">
          <dt className="text-ink-muted">Last health check:</dt>
          <dd>{connection.lastHealthAt ? formatDateTime(connection.lastHealthAt) : 'Never'}</dd>
        </div>
        {connection.lastErrorCode && (
          <div className="flex gap-2">
            <dt className="text-ink-muted">Last error:</dt>
            <dd className="text-destructive">{connection.lastErrorCode}</dd>
          </div>
        )}
      </dl>

      {canManage && mode === 'idle' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setMode('edit')}
          >
            Configure
          </Button>
          {provider.credentialTier === 'vault' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !vaultConfigured}
              onClick={() => setMode('rotate')}
            >
              Rotate secret
            </Button>
          )}
          {provider.inbound !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={submitIssueEndpoint}
            >
              Issue / rotate inbound URL
            </Button>
          )}
          {confirmingDisconnect ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={submitDisconnect}
              >
                Confirm disconnect — destroys the credential
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingDisconnect(false)}
              >
                Keep connection
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
      {canManage && provider.credentialTier === 'vault' && !vaultConfigured && (
        <p className="mt-2 text-xs text-ink-muted">
          Secret rotation is unavailable: the server vault key (INTEGRATIONS_ENCRYPTION_KEY) is not
          configured.
        </p>
      )}

      {canManage && mode === 'edit' && (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitEdit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`name-${connection.id}`}>Display name</Label>
            <Input
              id={`name-${connection.id}`}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <ConfigFields
            providerKey={provider.key}
            values={configValues}
            onChange={(key, value) => setConfigValues((v) => ({ ...v, [key]: value }))}
          />
          <div className="space-y-1.5">
            <Label htmlFor={`status-${connection.id}`}>Status</Label>
            <select
              id={`status-${connection.id}`}
              value={status}
              onChange={(e) => setStatus(e.target.value as 'CONNECTED' | 'DISCONNECTED')}
              className="h-9 rounded-lg border border-line bg-background px-2 text-sm"
            >
              <option value="CONNECTED">Connected</option>
              <option value="DISCONNECTED">Disconnected (destroys the stored credential)</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              Save changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setMode('idle')}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {canManage && mode === 'rotate' && (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitRotate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`secret-${connection.id}`}>Replacement secret</Label>
            <Input
              id={`secret-${connection.id}`}
              type="password"
              autoComplete="new-password"
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
              placeholder="Paste the new secret — it is never shown again"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              Rotate secret
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setMode('idle')}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  canManage,
  vaultConfigured,
  onChanged,
  onReveal,
}: {
  provider: IntegrationProviderWire;
  canManage: boolean;
  vaultConfigured: boolean;
  onChanged: () => Promise<void>;
  onReveal: (revealed: RevealedSecret) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [configValues, setConfigValues] = useState(() => initialConfigValues(provider));
  const [secret, setSecret] = useState('');

  const submitCreate = async () => {
    setBusy(true);
    try {
      await createConnection(
        buildCreateConnectionBody(provider.key, { displayName, configValues, secret }),
      );
      toast.success(`${provider.displayName} connected.`);
      setSecret('');
      setCreating(false);
      await onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{provider.displayName}</CardTitle>
        <p className="text-sm text-ink-muted">{provider.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {provider.connections.length === 0 && !creating && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">Not connected.</p>
            {canManage && (
              <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
                Connect
              </Button>
            )}
          </div>
        )}

        {provider.connections.map((connection) => (
          <ConnectionBlock
            key={connection.id}
            provider={provider}
            connection={connection}
            canManage={canManage}
            vaultConfigured={vaultConfigured}
            onChanged={onChanged}
            onReveal={onReveal}
          />
        ))}

        {canManage && creating && (
          <form
            className="space-y-3 rounded-lg border border-line px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`new-name-${provider.key}`}>Display name</Label>
              <Input
                id={`new-name-${provider.key}`}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <ConfigFields
              providerKey={provider.key}
              values={configValues}
              onChange={(key, value) => setConfigValues((v) => ({ ...v, [key]: value }))}
            />
            {provider.credentialTier === 'vault' ? (
              <div className="space-y-1.5">
                <Label htmlFor={`new-secret-${provider.key}`}>Secret (optional)</Label>
                <Input
                  id={`new-secret-${provider.key}`}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Paste a credential — stored encrypted, never shown again"
                />
                {!vaultConfigured && (
                  <p className="text-xs text-ink-muted">
                    The server vault key (INTEGRATIONS_ENCRYPTION_KEY) is not configured, so a
                    secret cannot be stored right now. The connection can still be created without
                    one.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-ink-muted">
                This provider uses the deployment credential ({provider.credentialRefEnvVar}) —
                there is nothing to paste here.
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                Connect
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function ConnectionsSection({
  providers,
  vaultConfigured,
  canManage,
  onChanged,
  onReveal,
}: {
  providers: readonly IntegrationProviderWire[];
  vaultConfigured: boolean;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onReveal: (revealed: RevealedSecret) => void;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Providers & connections</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Connect this workspace to external services. Credentials are stored encrypted or
          referenced from the deployment — never displayed after entry.
        </p>
      </div>
      {providers.map((provider) => (
        <ProviderCard
          key={provider.key}
          provider={provider}
          canManage={canManage}
          vaultConfigured={vaultConfigured}
          onChanged={onChanged}
          onReveal={onReveal}
        />
      ))}
    </section>
  );
}
