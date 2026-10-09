import { env } from '@/env';
import { IntegrationsVaultError, isVaultConfigured, type VaultEnvSource } from './secrets';

/**
 * Integrations tier gating — Phase 10 contract §4.3.
 *
 * Every provider in the registry declares how its credential is held:
 *
 * - Tier E (`'env'`) — env-referenced: the credential lives in the deployment
 *   environment and the connection row stores only a `credential_ref`. This
 *   tier is always available; whether the specific referenced env var is set
 *   is the provider adapter's own not-configured concern (the email
 *   precedent), not this gate's.
 * - Tier V (`'vault'`) — org-entered: an admin pastes the credential into the
 *   UI and it is stored encrypted by the vault (secrets.ts). Available only
 *   when `INTEGRATIONS_ENCRYPTION_KEY` is configured; otherwise connection
 *   creation fails with the typed VAULT_NOT_CONFIGURED outcome and the UI
 *   shows the not-configured state — while the app and every Tier E feature
 *   keep working.
 */
export type CredentialTier = 'env' | 'vault';

export interface IntegrationsConfig {
  /** True when the Tier V vault can encrypt/decrypt (key configured). */
  readonly vaultConfigured: boolean;
}

export function resolveIntegrationsConfig(source: VaultEnvSource = env): IntegrationsConfig {
  return { vaultConfigured: isVaultConfigured(source) };
}

/** Predicate form: may a connection declaring this tier be created at all? */
export function canCreateConnection(tier: CredentialTier, source: VaultEnvSource = env): boolean {
  return tier === 'env' ? true : isVaultConfigured(source);
}

/** Throwing form: raises the typed VAULT_NOT_CONFIGURED error (§4.3). */
export function assertCanCreateConnection(
  tier: CredentialTier,
  source: VaultEnvSource = env,
): void {
  if (!canCreateConnection(tier, source)) {
    throw new IntegrationsVaultError('VAULT_NOT_CONFIGURED');
  }
}

/** Result form for callers that branch on the outcome instead of catching. */
export function connectionGate(
  tier: CredentialTier,
  source: VaultEnvSource = env,
):
  { readonly allowed: true } | { readonly allowed: false; readonly error: IntegrationsVaultError } {
  if (canCreateConnection(tier, source)) return { allowed: true };
  return { allowed: false, error: new IntegrationsVaultError('VAULT_NOT_CONFIGURED') };
}
