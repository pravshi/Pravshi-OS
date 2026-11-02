/**
 * Application Use Case — Verify Custom Domain DNS.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import {
  type CustomDomainConfig,
  validateVerificationTransition,
} from '../domain/domain-verification';

export interface DomainRepository {
  getDomainConfig(
    siteId: string,
    customDomain: string,
    tx?: Tx,
  ): Promise<CustomDomainConfig | null>;
  updateDomainConfig(config: CustomDomainConfig, tx?: Tx): Promise<CustomDomainConfig>;
}

export interface DnsResolver {
  resolveTxt(host: string): Promise<string[]>;
}

export interface VerifyDomainDependencies {
  readonly domainRepository: DomainRepository;
  readonly dnsResolver: DnsResolver;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function verifyCustomDomain(
  auth: Authorization,
  siteId: string,
  domain: string,
  deps: VerifyDomainDependencies,
  tx?: Tx,
): Promise<{ verified: boolean; domainConfig: CustomDomainConfig }> {
  const config = await deps.domainRepository.getDomainConfig(siteId, domain, tx);
  if (!config) {
    throw new Error(`Custom domain configuration not found for domain: ${domain}`);
  }

  const host = config.verificationRecord.host;
  const expectedToken = config.verificationRecord.token;

  let resolvedRecords: string[] = [];
  try {
    resolvedRecords = await deps.dnsResolver.resolveTxt(host);
  } catch {
    resolvedRecords = [];
  }

  const tokenMatches = resolvedRecords.some((record) => record.includes(expectedToken));

  if (!tokenMatches) {
    const updated: CustomDomainConfig = {
      ...config,
      lastCheckedAt: new Date(),
      failureReason: 'DNS TXT challenge record not found or does not match expected token',
    };
    const saved = await deps.domainRepository.updateDomainConfig(updated, tx);
    return { verified: false, domainConfig: saved };
  }

  validateVerificationTransition(config.status, 'verified');

  const verifiedAt = new Date();
  const updated: CustomDomainConfig = {
    ...config,
    status: 'verified',
    verifiedAt,
    lastCheckedAt: verifiedAt,
    failureReason: undefined,
  };

  const saved = await deps.domainRepository.updateDomainConfig(updated, tx);

  if (deps.emitEvent) {
    await deps.emitEvent({
      type: 'website.domain.verified',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: verifiedAt.toISOString(),
      payload: {
        siteId,
        customDomain: domain,
        verifiedAt: verifiedAt.toISOString(),
      },
    });
  }

  return { verified: true, domainConfig: saved };
}
