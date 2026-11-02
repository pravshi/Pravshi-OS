/**
 * Real Estate Domain — Listings, Units, Pricing, Status, Location.
 *
 * Implements pure domain entities, invariants, and business rules for property listings
 * under Pravshi OS Blueprint §06.
 */

export const PROPERTY_TYPES = [
  'residential',
  'commercial',
  'industrial',
  'land',
  'mixed_use',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const LISTING_CATEGORIES = ['sale', 'rental', 'lease'] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

export const LISTING_STATUSES = [
  'draft',
  'active',
  'under_contract',
  'reserved',
  'sold',
  'leased',
  'archived',
  'delisted',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const FURNISHING_STATUSES = ['unfurnished', 'semi_furnished', 'fully_furnished'] as const;
export type FurnishingStatus = (typeof FURNISHING_STATUSES)[number];

export const FACING_DIRECTIONS = [
  'north',
  'south',
  'east',
  'west',
  'north_east',
  'north_west',
  'south_east',
  'south_west',
] as const;
export type FacingDirection = (typeof FACING_DIRECTIONS)[number];

export interface GeoLocation {
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly landmark?: string;
}

export interface PricingStructure {
  readonly basePrice: number;
  readonly currency: string;
  readonly maintenancePerMonth?: number;
  readonly securityDeposit?: number;
  readonly negotiable: boolean;
  readonly pricePerSqFt?: number;
  readonly taxOrGstPercentage?: number;
}

export interface PropertyUnit {
  readonly id: string;
  readonly unitNumber: string;
  readonly floor: number;
  readonly carpetAreaSqFt: number;
  readonly superBuiltUpAreaSqFt?: number;
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly balconyCount: number;
  readonly furnishingStatus: FurnishingStatus;
  readonly facingDirection?: FacingDirection;
  readonly parkingSlots: number;
  readonly isAvailable: boolean;
}

export interface RealEstateListing {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly propertyType: PropertyType;
  readonly category: ListingCategory;
  readonly status: ListingStatus;
  readonly pricing: PricingStructure;
  readonly location: GeoLocation;
  readonly units: readonly PropertyUnit[];
  readonly amenities: readonly string[];
  readonly images: readonly string[];
  readonly publishedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ListingDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ListingDomainError';
  }
}

/**
 * Invariant: Pricing validation.
 * Base price must be positive, currency valid, security deposit applicable for rentals.
 */
export function validateListingPricing(category: ListingCategory, pricing: PricingStructure): void {
  if (pricing.basePrice <= 0) {
    throw new ListingDomainError('Base price must be strictly positive', 'INVALID_BASE_PRICE');
  }
  if (!pricing.currency || pricing.currency.trim().length !== 3) {
    throw new ListingDomainError('Currency must be a valid 3-letter ISO code', 'INVALID_CURRENCY');
  }
  if (
    (category === 'rental' || category === 'lease') &&
    pricing.securityDeposit !== undefined &&
    pricing.securityDeposit < 0
  ) {
    throw new ListingDomainError('Security deposit cannot be negative', 'INVALID_SECURITY_DEPOSIT');
  }
  if (
    pricing.taxOrGstPercentage !== undefined &&
    (pricing.taxOrGstPercentage < 0 || pricing.taxOrGstPercentage > 100)
  ) {
    throw new ListingDomainError(
      'Tax percentage must be between 0 and 100',
      'INVALID_TAX_PERCENTAGE',
    );
  }
}

/**
 * Invariant: A listing can only be published (active) if it has location, pricing, and at least one unit/area defined.
 */
export function assertListingPublishable(listing: RealEstateListing): void {
  if (listing.status === 'archived' || listing.status === 'delisted') {
    throw new ListingDomainError(
      `Cannot publish a listing in status ${listing.status}`,
      'CANNOT_PUBLISH_ARCHIVED',
    );
  }
  if (!listing.title || listing.title.trim().length < 5) {
    throw new ListingDomainError('Title must be at least 5 characters long', 'TITLE_TOO_SHORT');
  }
  if (!listing.location.city || !listing.location.state || !listing.location.country) {
    throw new ListingDomainError(
      'Complete location (city, state, country) is required to publish',
      'INCOMPLETE_LOCATION',
    );
  }
  validateListingPricing(listing.category, listing.pricing);
  if (listing.units.length === 0) {
    throw new ListingDomainError(
      'At least one property unit/floor-plan must be defined before publishing',
      'NO_UNITS_DEFINED',
    );
  }
}
