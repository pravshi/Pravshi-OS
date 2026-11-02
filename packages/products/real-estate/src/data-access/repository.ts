/**
 * Real Estate Data Access — Tenant-scoped Repository Contracts.
 *
 * All operations require tenant authorization context or an active transaction
 * bound to an authorized database connection. Queries MUST fail-closed on tenant mismatch.
 */

import type { Tx } from '@/lib/db/authorized';
import type { Authorization } from '@/lib/authz/require-permission';
import type { RealEstateListing, ListingStatus, PropertyType } from '../domain/listing';
import type { SiteVisit, SiteVisitStatus } from '../domain/site-visit';
import type { RealEstateDeal, RealEstateDealStage } from '../domain/deal';

export interface ListingFilter {
  readonly status?: ListingStatus;
  readonly propertyType?: PropertyType;
  readonly city?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RealEstateListingRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<RealEstateListing | null>;
  list(auth: Authorization, filter?: ListingFilter, tx?: Tx): Promise<readonly RealEstateListing[]>;
  create(
    auth: Authorization,
    listing: Omit<RealEstateListing, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<RealEstateListing>;
  update(
    auth: Authorization,
    id: string,
    patch: Partial<RealEstateListing>,
    tx?: Tx,
  ): Promise<RealEstateListing>;
  delete(auth: Authorization, id: string, tx?: Tx): Promise<void>;
}

export interface SiteVisitFilter {
  readonly listingId?: string;
  readonly agentId?: string;
  readonly status?: SiteVisitStatus;
  readonly fromDate?: Date;
  readonly toDate?: Date;
}

export interface SiteVisitRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<SiteVisit | null>;
  list(auth: Authorization, filter?: SiteVisitFilter, tx?: Tx): Promise<readonly SiteVisit[]>;
  create(
    auth: Authorization,
    visit: Omit<SiteVisit, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<SiteVisit>;
  update(auth: Authorization, id: string, patch: Partial<SiteVisit>, tx?: Tx): Promise<SiteVisit>;
}

export interface RealEstateDealRepository {
  findById(auth: Authorization, id: string, tx?: Tx): Promise<RealEstateDeal | null>;
  list(
    auth: Authorization,
    listingId?: string,
    stage?: RealEstateDealStage,
    tx?: Tx,
  ): Promise<readonly RealEstateDeal[]>;
  create(
    auth: Authorization,
    deal: Omit<RealEstateDeal, 'createdAt' | 'updatedAt'>,
    tx?: Tx,
  ): Promise<RealEstateDeal>;
  update(
    auth: Authorization,
    id: string,
    patch: Partial<RealEstateDeal>,
    tx?: Tx,
  ): Promise<RealEstateDeal>;
}
