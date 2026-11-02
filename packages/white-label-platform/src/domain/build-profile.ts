/**
 * White-Label Platform Domain — Build Distribution Profiles.
 *
 * Implements distribution configurations for iOS and Android store pipelines.
 * STRICT SECURITY INVARIANT: Raw private keys, passwords, or certificates
 * MUST NEVER be stored in the database or profile objects. Only opaque vault references are stored.
 */

export const TARGET_PLATFORMS = ['ios', 'android', 'all'] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

export const IOS_DISTRIBUTION_TYPES = ['app-store', 'ad-hoc', 'enterprise', 'development'] as const;
export type IosDistributionType = (typeof IOS_DISTRIBUTION_TYPES)[number];

export interface IosBuildProfile {
  readonly teamId: string;
  readonly bundleId: string;
  readonly signingCertificateRef: string; // Secret vault ARN / reference ID
  readonly provisioningProfileRef: string; // Secret vault reference ID
  readonly exportMethod: IosDistributionType;
}

export interface AndroidBuildProfile {
  readonly applicationId: string;
  readonly keystoreRef: string; // Secret vault reference ID
  readonly keyAlias: string;
  readonly keyPasswordRef: string; // Secret vault reference ID
  readonly buildType: 'release' | 'debug';
}

export interface DistributionProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly platform: TargetPlatform;
  readonly ios?: IosBuildProfile;
  readonly android?: AndroidBuildProfile;
  readonly environment: 'production' | 'staging';
  readonly isReady: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class BuildProfileSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BuildProfileSecurityError';
  }
}

const RAW_SECRET_PATTERNS = [
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i,
  /-----BEGIN\s+CERTIFICATE-----/i,
  /password\s*[:=]\s*[^\s]+/i,
  /secret\s*[:=]\s*[^\s]+/i,
];

/**
 * Security Invariant: Scans distribution profile for accidental raw credential leakage.
 */
export function assertNoRawSecretsInProfile(profile: Record<string, unknown>): void {
  const serialized = JSON.stringify(profile);
  for (const pattern of RAW_SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new BuildProfileSecurityError(
        'Raw private key or secret material detected in profile. Only opaque vault references are permitted.',
        'RAW_SECRET_LEAKAGE_DETECTED',
      );
    }
  }
}
