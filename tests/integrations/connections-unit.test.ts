import { describe, expect, it } from 'vitest';
import {
  assertNoIdentityFields,
  findCredentialKeys,
  toConnectionSummary,
  validateConnectionConfig,
  type IntegrationConnectionSummary,
} from '@/lib/integrations/connections';
import {
  fromVaultError,
  IntegrationsError,
  IntegrationsVaultError,
  isIntegrationsError,
} from '@/lib/integrations/errors';
import {
  INTEGRATION_PROVIDERS,
  PROVIDER_KEYS,
  getProviderDefinition,
  listProviderDefinitions,
} from '@/lib/integrations/providers';
import { emailProvider } from '@/lib/integrations/providers/email';
import { webhooksProvider } from '@/lib/integrations/providers/webhooks';

/**
 * Connections-service unit suite (Phase 10, Wave C). DB-free by design —
 * the Nov-1 rule forbids local database connections, so this suite covers
 * exactly the pure logic of the service: the provider registry's
 * integrity, config hygiene (credential-key rejection + provider schema
 * validation), the identity-field guard, the error taxonomy's vault
 * bridge, and the safe-metadata DTO shaping. Everything that touches
 * Postgres (RLS isolation, singleton enforcement at the row level, audit
 * writes) is covered by the CI-run DB suites (Wave J).
 */

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function expectIntegrationsError(error: unknown, code: string): IntegrationsError {
  expect(isIntegrationsError(error)).toBe(true);
  const err = error as IntegrationsError;
  expect(err.code).toBe(code);
  return err;
}

describe('provider registry integrity', () => {
  it('has unique keys, and every record key equals its definition key', () => {
    expect(new Set(PROVIDER_KEYS).size).toBe(PROVIDER_KEYS.length);
    for (const [key, definition] of Object.entries(INTEGRATION_PROVIDERS)) {
      expect(definition.key).toBe(key);
      expect(getProviderDefinition(key)).toBe(definition);
    }
    expect(listProviderDefinitions()).toHaveLength(PROVIDER_KEYS.length);
    expect(getProviderDefinition('no-such-provider')).toBeNull();
  });

  it('declares only valid tiers, with the Tier E env ref present exactly for env-tier providers', () => {
    for (const definition of listProviderDefinitions()) {
      expect(['env', 'vault']).toContain(definition.credentialTier);
      if (definition.credentialTier === 'env') {
        expect(definition.credentialRefEnvVar).toBeTruthy();
      } else {
        expect(definition.credentialRefEnvVar).toBeNull();
      }
      expect(typeof definition.singleton).toBe('boolean');
    }
  });

  it('ships the two V1 providers with the contract tiers and shapes (§4.6)', () => {
    expect(PROVIDER_KEYS).toEqual(['email', 'webhooks']);
    expect(emailProvider.credentialTier).toBe('env');
    expect(emailProvider.credentialRefEnvVar).toBe('EMAIL_PROVIDER_API_KEY');
    expect(emailProvider.singleton).toBe(true);
    expect(emailProvider.inbound).toBeNull();
    expect(webhooksProvider.credentialTier).toBe('vault');
    expect(webhooksProvider.inbound?.verification).toBe('endpoint-token');
    expect(webhooksProvider.inbound?.maxBodyBytes).toBe(256 * 1024);
  });

  it('every defaultConfig parses under its own provider schema', () => {
    for (const definition of listProviderDefinitions()) {
      const parsed = definition.configSchema.safeParse(definition.defaultConfig);
      expect(parsed.success).toBe(true);
      expect(validateConnectionConfig(definition, definition.defaultConfig)).toEqual(
        definition.defaultConfig,
      );
    }
  });
});

describe('validateConnectionConfig — schema validation', () => {
  it('accepts a valid email config and returns the parsed shape', () => {
    const config = validateConnectionConfig(emailProvider, {
      fromAddress: 'hello@example.com',
      fromName: 'Pravshi',
    });
    expect(config).toEqual({ fromAddress: 'hello@example.com', fromName: 'Pravshi' });
  });

  it('rejects an invalid email address as VALIDATION naming the field path only', () => {
    const err = expectIntegrationsError(
      caught(() => validateConnectionConfig(emailProvider, { fromAddress: 'not-an-email' })),
      'VALIDATION',
    );
    expect(err.detail).toBe('config.fromAddress');
    expect(err.message).not.toContain('not-an-email');
  });

  it('rejects unknown config keys (strict schemas)', () => {
    expectIntegrationsError(
      caught(() => validateConnectionConfig(emailProvider, { fromAddress: 'a@b.co', bogus: 1 })),
      'VALIDATION',
    );
    expectIntegrationsError(
      caught(() => validateConnectionConfig(webhooksProvider, { anything: true })),
      'VALIDATION',
    );
  });

  it('accepts the webhooks boolean toggles', () => {
    expect(
      validateConnectionConfig(webhooksProvider, { outboundEnabled: false, inboundEnabled: true }),
    ).toEqual({ outboundEnabled: false, inboundEnabled: true });
  });
});

describe('validateConnectionConfig — credential-shaped keys are rejected before parsing', () => {
  const SENTINEL = 'SENTINEL-SECRET-VALUE';

  it('rejects credential keys at the top level, naming the path and never the value', () => {
    for (const key of ['apiKey', 'api_key', 'signing_secret', 'token', 'password', 'credential']) {
      const err = expectIntegrationsError(
        caught(() => validateConnectionConfig(webhooksProvider, { [key]: SENTINEL })),
        'VALIDATION',
      );
      expect(err.detail).toBe(`config.${key}`);
      expect(err.message).not.toContain(SENTINEL);
    }
  });

  it('finds credential keys nested in objects and arrays (findCredentialKeys paths)', () => {
    expect(findCredentialKeys({ nested: { refresh_token: SENTINEL } })).toEqual([
      'config.nested.refresh_token',
    ]);
    expect(findCredentialKeys({ items: [{ password: SENTINEL }] })).toEqual([
      'config.items.0.password',
    ]);
    expect(findCredentialKeys({ outboundEnabled: true })).toEqual([]);
    expect(findCredentialKeys(null)).toEqual([]);
    expect(findCredentialKeys('a string')).toEqual([]);
  });

  it('rejects a nested credential key even under a schema-unknown parent', () => {
    expectIntegrationsError(
      caught(() =>
        validateConnectionConfig(emailProvider, {
          fromAddress: 'a@b.co',
          auth: { token: SENTINEL },
        }),
      ),
      'VALIDATION',
    );
  });
});

describe('assertNoIdentityFields — the service-level identity freeze', () => {
  it('rejects every identity spelling', () => {
    for (const key of [
      'id',
      'orgId',
      'org_id',
      'providerKey',
      'provider_key',
      'connectedBy',
      'created_at',
    ]) {
      expectIntegrationsError(
        caught(() => assertNoIdentityFields({ [key]: 'x', displayName: 'ok' })),
        'VALIDATION',
      );
    }
  });

  it('accepts ordinary update fields', () => {
    expect(() =>
      assertNoIdentityFields({ displayName: 'Mail', config: {}, status: 'CONNECTED' }),
    ).not.toThrow();
  });
});

describe('toConnectionSummary — safe metadata shaping (§4.3)', () => {
  const CIPHERTEXT_SENTINEL =
    'intg.v1.U0VOVElORUwtTk9OQ0U.U0VOVElORUwtQ0lQSEVSVEVYVA.U0VOVElORUwtVEFHMTY';

  const baseRow = {
    id: '11111111-1111-4111-8111-111111111111',
    providerKey: 'email',
    displayName: 'Org mail',
    status: 'CONNECTED' as const,
    config: { fromAddress: 'hello@example.com' },
    credentialCiphertext: null,
    credentialRef: null,
    connectedBy: '22222222-2222-4222-8222-222222222222',
    lastHealthAt: null,
    lastErrorCode: null,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  };

  it('exposes exactly the safe field set — no credential fields exist on the DTO', () => {
    const summary = toConnectionSummary({
      ...baseRow,
      credentialCiphertext: CIPHERTEXT_SENTINEL,
      credentialRef: 'EMAIL_PROVIDER_API_KEY',
    });
    expect(Object.keys(summary).sort()).toEqual(
      [
        'id',
        'providerKey',
        'displayName',
        'status',
        'config',
        'hasCredential',
        'maskedCredentialRef',
        'connectedBy',
        'lastHealthAt',
        'lastErrorCode',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain(CIPHERTEXT_SENTINEL);
    expect(serialised).not.toContain('U0VOVElORUw');
    expect(serialised).not.toContain('credentialCiphertext');
    expect(serialised).not.toContain('credentialNonce');
  });

  it('derives hasCredential from either credential channel', () => {
    expect(toConnectionSummary(baseRow).hasCredential).toBe(false);
    expect(
      toConnectionSummary({ ...baseRow, credentialCiphertext: CIPHERTEXT_SENTINEL }).hasCredential,
    ).toBe(true);
    expect(
      toConnectionSummary({ ...baseRow, credentialRef: 'EMAIL_PROVIDER_API_KEY' }).hasCredential,
    ).toBe(true);
  });

  it('masks the Tier E ref to its last 4 and leaves Tier V rows with no masked ref', () => {
    const tierE = toConnectionSummary({ ...baseRow, credentialRef: 'EMAIL_PROVIDER_API_KEY' });
    expect(tierE.maskedCredentialRef).toBe('••••_KEY');
    const tierV: IntegrationConnectionSummary = toConnectionSummary({
      ...baseRow,
      credentialCiphertext: CIPHERTEXT_SENTINEL,
    });
    expect(tierV.maskedCredentialRef).toBeNull();
    expect(toConnectionSummary(baseRow).maskedCredentialRef).toBeNull();
  });

  it('normalises timestamps to Date instances', () => {
    const summary = toConnectionSummary(baseRow);
    expect(summary.createdAt).toBeInstanceOf(Date);
    expect(summary.lastHealthAt).toBeNull();
  });
});

describe('error taxonomy', () => {
  it('maps every code to its HTTP status', () => {
    expect(new IntegrationsError('NOT_FOUND').status).toBe(404);
    expect(new IntegrationsError('FORBIDDEN').status).toBe(403);
    expect(new IntegrationsError('VALIDATION').status).toBe(400);
    expect(new IntegrationsError('CONFLICT').status).toBe(409);
    expect(new IntegrationsError('NOT_CONFIGURED').status).toBe(503);
    expect(new IntegrationsError('CREDENTIAL_UNREADABLE').status).toBe(500);
  });

  it('bridges vault errors into the taxonomy', () => {
    const notConfigured = expectIntegrationsError(
      fromVaultError(new IntegrationsVaultError('VAULT_NOT_CONFIGURED')),
      'NOT_CONFIGURED',
    );
    expect(notConfigured.status).toBe(503);
    expectIntegrationsError(
      fromVaultError(new IntegrationsVaultError('VAULT_DECRYPT_FAILED')),
      'CREDENTIAL_UNREADABLE',
    );
    expectIntegrationsError(
      fromVaultError(new IntegrationsVaultError('VAULT_MALFORMED_ENVELOPE')),
      'CREDENTIAL_UNREADABLE',
    );
    expectIntegrationsError(
      fromVaultError(new IntegrationsVaultError('VAULT_UNSUPPORTED_KEY_VERSION')),
      'CREDENTIAL_UNREADABLE',
    );
  });

  it('passes non-vault values through unchanged', () => {
    const foreign = new Error('boom');
    expect(fromVaultError(foreign)).toBe(foreign);
    const own = new IntegrationsError('CONFLICT');
    expect(fromVaultError(own)).toBe(own);
  });
});
