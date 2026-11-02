/**
 * White-Label Platform Domain — Version Governance & Instant Suspension.
 *
 * Implements mobile client version gating, forced upgrade enforcement,
 * and tenant instant-killswitch capabilities under Blueprint §12.
 */

export interface VersionGovernancePolicy {
  readonly organizationId: string;
  readonly platform: 'ios' | 'android';
  readonly minimumSupportedVersion: string; // e.g. "1.2.0"
  readonly recommendedVersion: string; // e.g. "1.4.0"
  readonly forceUpgrade: boolean;
  readonly upgradeUrl: string;
  readonly instantSuspension: boolean;
  readonly suspensionMessage?: string;
}

export interface VersionEvaluationResult {
  readonly allowed: boolean;
  readonly forceUpgrade: boolean;
  readonly message?: string;
  readonly upgradeUrl?: string;
}

/**
 * Parses and compares two semantic version strings (major.minor.patch).
 * Returns true if v1 < v2.
 */
export function isVersionBelowMinimum(clientVersion: string, minimumVersion: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => parseInt(part.replace(/[^0-9]/g, ''), 10) || 0);

  const [maj1 = 0, min1 = 0, pat1 = 0] = parse(clientVersion);
  const [maj2 = 0, min2 = 0, pat2 = 0] = parse(minimumVersion);

  if (maj1 !== maj2) return maj1 < maj2;
  if (min1 !== min2) return min1 < min2;
  return pat1 < pat2;
}

/**
 * Evaluates whether an incoming client request is permitted according to tenant version governance.
 */
export function evaluateVersionAccess(
  clientVersion: string,
  policy: VersionGovernancePolicy,
): VersionEvaluationResult {
  if (policy.instantSuspension) {
    return {
      allowed: false,
      forceUpgrade: false,
      message:
        policy.suspensionMessage ?? 'Application access has been suspended by administration.',
    };
  }

  const isOutdated = isVersionBelowMinimum(clientVersion, policy.minimumSupportedVersion);

  if (isOutdated && policy.forceUpgrade) {
    return {
      allowed: false,
      forceUpgrade: true,
      message: `Your app version (${clientVersion}) is no longer supported. Please update to continue.`,
      upgradeUrl: policy.upgradeUrl,
    };
  }

  return {
    allowed: true,
    forceUpgrade: false,
  };
}
