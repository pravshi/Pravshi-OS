/**
 * Website Platform Domain — Site Registry & Tenant Binding.
 *
 * Implements site entity, 1:1 tenant binding invariants, subdomain validations,
 * and lifecycle status states under Pravshi OS Blueprint §13.
 */

export const SITE_STATUSES = ['pending', 'active', 'disabled', 'maintenance'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export interface SeoMetadata {
  readonly title: string;
  readonly description: string;
  readonly ogImageUrl?: string;
  readonly faviconUrl?: string;
  readonly keywords?: readonly string[];
}

export interface SiteThemeConfig {
  readonly primaryColor: string;
  readonly secondaryColor?: string;
  readonly fontFamily?: string;
  readonly logoUrl?: string;
  readonly darkMode: boolean;
}

export interface Site {
  readonly id: string;
  readonly organizationId: string;
  readonly subdomain: string; // e.g. "acme.pravshi.site"
  readonly customDomain?: string; // e.g. "acme.com"
  readonly name: string;
  readonly description?: string;
  readonly status: SiteStatus;
  readonly seo: SeoMetadata;
  readonly theme: SiteThemeConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class SiteDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SiteDomainError';
  }
}

const RFC_1123_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SUBDOMAINS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'cdn',
  'dashboard',
  'docs',
  'help',
  'mail',
  'platform',
  'portal',
  'root',
  'secure',
  'status',
  'support',
  'system',
  'www',
]);

/**
 * Invariant: Subdomain validation conforming to RFC 1123 and reserved list.
 */
export function validateSubdomain(subdomain: string): void {
  const normalized = subdomain.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 63) {
    throw new SiteDomainError(
      'Subdomain must be between 3 and 63 characters',
      'INVALID_SUBDOMAIN_LENGTH',
    );
  }
  if (!RFC_1123_SUBDOMAIN.test(normalized)) {
    throw new SiteDomainError(
      'Subdomain must contain only lowercase letters, numbers, and non-consecutive hyphens',
      'INVALID_SUBDOMAIN_FORMAT',
    );
  }
  if (RESERVED_SUBDOMAINS.has(normalized)) {
    throw new SiteDomainError(
      `Subdomain "${normalized}" is reserved and cannot be assigned`,
      'RESERVED_SUBDOMAIN',
    );
  }
}

/**
 * Invariant: 1:1 tenant binding assertion.
 * Each organization in V1 can possess at most one active site.
 */
export function assertOneSitePerTenant(
  existingSites: readonly Site[],
  organizationId: string,
): void {
  const activeExisting = existingSites.filter(
    (s) => s.organizationId === organizationId && s.status !== 'disabled',
  );
  if (activeExisting.length > 0) {
    throw new SiteDomainError(
      `Tenant ${organizationId} already has an active site binding (${activeExisting[0]?.subdomain})`,
      'TENANT_SITE_LIMIT_EXCEEDED',
    );
  }
}
