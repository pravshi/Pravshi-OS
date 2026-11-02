/**
 * Application Use Case — Project Public Listing.
 *
 * Implements safe, PII-scrubbed public projection for web display.
 */

import type { Tx } from '@pravshi/database';
import { type PublicListingProjection, toPublicListingProjection } from '../domain/projection';

export interface PublicListingSource {
  getListingForProjection(
    siteId: string,
    listingIdOrSlug: string,
    tx?: Tx,
  ): Promise<{
    id: string;
    title: string;
    slug: string;
    description: string;
    propertyType: string;
    category: string;
    pricing: { basePrice: number; currency: string; negotiable?: boolean };
    location: {
      city: string;
      state: string;
      postalCode: string;
      country: string;
      landmark?: string;
    };
    units?: readonly {
      unitNumber: string;
      floor: number;
      carpetAreaSqFt: number;
      bedrooms: number;
      bathrooms: number;
      isAvailable: boolean;
    }[];
    amenities?: readonly string[];
    images?: readonly string[];
  } | null>;
}

export async function projectPublicListing(
  siteId: string,
  listingIdOrSlug: string,
  source: PublicListingSource,
  tx?: Tx,
): Promise<PublicListingProjection | null> {
  const listing = await source.getListingForProjection(siteId, listingIdOrSlug, tx);
  if (!listing) return null;

  return toPublicListingProjection(listing);
}
