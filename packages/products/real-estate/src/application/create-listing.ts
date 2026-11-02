/**
 * Application Use Case — Create Real Estate Listing.
 *
 * Validates domain rules, writes through tenant-scoped repository,
 * and optionally dispatches domain events if immediately published.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import {
  type RealEstateListing,
  type PropertyUnit,
  assertListingPublishable,
  validateListingPricing,
} from '../domain/listing';
import type { CreateListingInput } from '../api/schemas';
import type { RealEstateListingRepository } from '../data-access/repository';

export interface CreateListingDependencies {
  readonly listingRepository: RealEstateListingRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function createListing(
  auth: Authorization,
  input: CreateListingInput,
  deps: CreateListingDependencies,
  tx?: Tx,
): Promise<RealEstateListing> {
  // Validate pricing invariants
  validateListingPricing(input.category, input.pricing);

  const units: PropertyUnit[] = input.units.map((u) => ({
    id: u.id ?? crypto.randomUUID(),
    unitNumber: u.unitNumber,
    floor: u.floor,
    carpetAreaSqFt: u.carpetAreaSqFt,
    superBuiltUpAreaSqFt: u.superBuiltUpAreaSqFt,
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    balconyCount: u.balconyCount,
    furnishingStatus: u.furnishingStatus,
    facingDirection: u.facingDirection,
    parkingSlots: u.parkingSlots,
    isAvailable: u.isAvailable,
  }));

  const candidate: Omit<RealEstateListing, 'createdAt' | 'updatedAt'> = {
    id: crypto.randomUUID(),
    organizationId: auth.ctx.orgId,
    title: input.title,
    slug: input.slug,
    description: input.description,
    propertyType: input.propertyType,
    category: input.category,
    status: 'draft',
    pricing: input.pricing,
    location: input.location,
    units,
    amenities: input.amenities,
    images: input.images,
  };

  return await deps.listingRepository.create(auth, candidate, tx);
}

export async function publishListing(
  auth: Authorization,
  listingId: string,
  deps: CreateListingDependencies,
  tx?: Tx,
): Promise<RealEstateListing> {
  const listing = await deps.listingRepository.findById(auth, listingId, tx);
  if (!listing) {
    throw new Error(`Listing not found: ${listingId}`);
  }

  assertListingPublishable(listing);

  const updated = await deps.listingRepository.update(
    auth,
    listingId,
    { status: 'active', publishedAt: new Date() },
    tx,
  );

  if (deps.emitEvent) {
    await deps.emitEvent({
      type: 'real_estate.listing.published',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: new Date().toISOString(),
      payload: {
        listingId: updated.id,
        title: updated.title,
        slug: updated.slug,
        category: updated.category,
        propertyType: updated.propertyType,
        basePrice: updated.pricing.basePrice,
        currency: updated.pricing.currency,
        city: updated.location.city,
        state: updated.location.state,
      },
    });
  }

  return updated;
}
