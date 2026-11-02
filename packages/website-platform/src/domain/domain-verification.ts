/**
 * Website Platform Domain — DNS Verification State Machine.
 *
 * Implements custom domain ownership validation via TXT/CNAME records.
 * State machine: pending -> verified -> active (or failed/revoked).
 */

export const DOMAIN_VERIFICATION_STATUSES = [
  'pending',
  'verified',
  'active',
  'failed',
  'revoked',
] as const;
export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

export const DNS_RECORD_TYPES = ['TXT', 'CNAME'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsVerificationRecord {
  readonly recordType: DnsRecordType;
  readonly host: string;
  readonly expectedValue: string;
  readonly token: string;
}

export interface CustomDomainConfig {
  readonly id: string;
  readonly siteId: string;
  readonly domain: string;
  readonly status: DomainVerificationStatus;
  readonly verificationRecord: DnsVerificationRecord;
  readonly lastCheckedAt?: Date;
  readonly verifiedAt?: Date;
  readonly activatedAt?: Date;
  readonly failureReason?: string;
  readonly sslCertIssued: boolean;
}

export class DomainVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DomainVerificationError';
  }
}

/**
 * Validates discrete state machine transitions for custom domain verification.
 */
export function validateVerificationTransition(
  current: DomainVerificationStatus,
  next: DomainVerificationStatus,
): void {
  if (current === next) return;

  const validTransitions: Record<DomainVerificationStatus, readonly DomainVerificationStatus[]> = {
    pending: ['verified', 'failed'],
    verified: ['active', 'failed', 'revoked'],
    active: ['revoked', 'failed'],
    failed: ['pending'],
    revoked: ['pending'],
  };

  const allowed = validTransitions[current];
  if (!allowed || !allowed.includes(next)) {
    throw new DomainVerificationError(
      `Invalid domain verification transition from ${current} to ${next}`,
      'INVALID_TRANSITION',
    );
  }
}

/**
 * Generates a cryptographically secure, collision-resistant verification token for DNS TXT records.
 */
export function generateDomainVerificationToken(
  domain: string,
  siteId: string,
): DnsVerificationRecord {
  void siteId;
  const token = `pravshi-site-verification-${crypto.randomUUID().replace(/-/g, '')}`;
  return {
    recordType: 'TXT',
    host: `_pravshi-challenge.${domain.toLowerCase()}`,
    expectedValue: token,
    token,
  };
}
