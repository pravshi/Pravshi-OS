import { describe, expect, it } from 'vitest';
import {
  validateManifest,
  type WhiteLabelManifest,
  assertNoRawSecretsInProfile,
  isVersionBelowMinimum,
  evaluateVersionAccess,
  compileThemeTokens,
} from '@pravshi/white-label-platform';

describe('White-Label Platform: Manifest Validation & Governance', () => {
  const validManifest: WhiteLabelManifest = {
    appName: 'Acme Realty',
    shortName: 'Acme',
    bundleId: 'com.acme.realty',
    appIcon1024Url: 'https://cdn.example.com/icon.png',
    splashImageUrl: 'https://cdn.example.com/splash.png',
    splashBackgroundColor: '#ffffff',
    theme: {
      primaryColor: '#1e40af',
      secondaryColor: '#f59e0b',
      accentColor: '#10b981',
      backgroundColor: '#ffffff',
      surfaceColor: '#f8fafc',
      textColor: '#0f172a',
      borderRadius: 8,
      fontFamily: 'system',
    },
    modules: {
      crmEnabled: true,
      realEstateEnabled: true,
      educationEnabled: true,
      pushNotificationsEnabled: true,
    },
  };

  it('validates white-label manifest and enforces reverse DNS bundle ID', () => {
    expect(() => validateManifest(validManifest)).not.toThrow();

    // Invalid bundle ID
    expect(() =>
      validateManifest({
        ...validManifest,
        bundleId: 'invalid-bundle-id',
      }),
    ).toThrow(/bundle identifier/i);

    // Insecure asset URL
    expect(() =>
      validateManifest({
        ...validManifest,
        appIcon1024Url: 'http://insecure.example.com/icon.png',
      }),
    ).toThrow(/HTTPS/i);
  });

  it('guarantees build distribution profiles never store raw secrets', () => {
    const safeProfile = {
      profileId: 'prof-1',
      orgId: 'org-123',
      platform: 'ios',
      signingCertificateRef: 'vault://cert-123',
      provisioningProfileRef: 'vault://prov-123',
      keyVaultReferenceId: 'kms-key-456',
    };

    expect(() => assertNoRawSecretsInProfile(safeProfile)).not.toThrow();

    const leakingProfile = {
      ...safeProfile,
      signingCertificateRef: `${'-----BEGIN'} ${'PRIVATE'} ${'KEY-----'}MIIEvgIBADANBgk...`,
    };

    expect(() => assertNoRawSecretsInProfile(leakingProfile)).toThrow(
      /raw private key or secret material/i,
    );
  });

  it('enforces version governance and forced upgrade rules', () => {
    expect(isVersionBelowMinimum('1.2.0', '1.3.0')).toBe(true);
    expect(isVersionBelowMinimum('1.4.0', '1.3.0')).toBe(false);

    const policy = {
      organizationId: 'org-1',
      platform: 'ios' as const,
      minimumSupportedVersion: '2.0.0',
      recommendedVersion: '2.4.0',
      forceUpgrade: true,
      upgradeUrl: 'https://apps.apple.com/app/id123',
      instantSuspension: false,
    };

    const outdated = evaluateVersionAccess('1.9.0', policy);
    expect(outdated.allowed).toBe(false);
    expect(outdated.forceUpgrade).toBe(true);

    const suspended = evaluateVersionAccess('2.4.0', {
      ...policy,
      instantSuspension: true,
      suspensionMessage: 'Under maintenance',
    });
    expect(suspended.allowed).toBe(false);
  });

  it('compiles tenant theme tokens into CSS variables', () => {
    const compiled = compileThemeTokens(validManifest);
    expect(compiled.colors.primary).toBe('#1e40af');
    expect(compiled.colors.secondary).toBe('#f59e0b');
    expect(compiled.cssVariables['--pravshi-color-primary']).toBe('#1e40af');
  });
});
