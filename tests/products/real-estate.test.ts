import { describe, expect, it } from 'vitest';
import {
  assertListingPublishable,
  validateListingPricing,
  validateSalesStageTransition,
  validateCommissionSplits,
  CreateListingSchema,
  type RealEstateListing,
} from '@pravshi/product-real-estate';

describe('Real Estate Vertical: Domain Rules & Invariants', () => {
  it('validates pricing invariants: base price must be positive', () => {
    expect(() =>
      validateListingPricing('rental', {
        basePrice: -1,
        currency: 'INR',
        negotiable: false,
      }),
    ).toThrow(/strictly positive/i);

    expect(() =>
      validateListingPricing('sale', {
        basePrice: 5_000_000,
        currency: 'INR',
        negotiable: false,
      }),
    ).not.toThrow();
  });

  it('enforces listing publishability constraints', () => {
    const invalidListing: RealEstateListing = {
      id: 'l-1',
      organizationId: 'org-1',
      title: 'Luxury Villa',
      slug: 'luxury-villa',
      description: 'A grand villa with modern architecture and spacious garden',
      category: 'sale',
      propertyType: 'residential',
      status: 'draft',
      pricing: { basePrice: 10_000_000, currency: 'INR', negotiable: false },
      location: {
        addressLine1: '123 Palm Ave',
        city: 'Bangalore',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'India',
      },
      units: [],
      amenities: [],
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(() => assertListingPublishable(invalidListing)).toThrow(/at least one property unit/i);
  });

  it('enforces commission splits cannot exceed 100%', () => {
    expect(() =>
      validateCommissionSplits([
        {
          recipientId: 'r-1',
          recipientName: 'Agent A',
          role: 'listing_agent',
          percentage: 60,
          payoutStatus: 'pending',
        },
        {
          recipientId: 'r-2',
          recipientName: 'Agent B',
          role: 'selling_agent',
          percentage: 50,
          payoutStatus: 'pending',
        },
      ]),
    ).toThrow(/cannot exceed 100%/i);
  });

  it('enforces sales deal stage pipeline progression', () => {
    expect(() => validateSalesStageTransition('inquiry', 'site_visit_scheduled')).not.toThrow();
    expect(() => validateSalesStageTransition('inquiry', 'closed_won')).toThrow(
      /cannot close won/i,
    );
  });

  it('validates API schemas for listing creation', () => {
    const valid = CreateListingSchema.safeParse({
      title: 'Skyline Penthouse',
      slug: 'skyline-penthouse',
      description: 'A luxurious modern penthouse with scenic city skyline views',
      category: 'sale',
      propertyType: 'residential',
      pricing: { basePrice: 25_000_000, currency: 'INR' },
      location: {
        addressLine1: 'MG Road',
        city: 'Bangalore',
        state: 'Karnataka',
        postalCode: '560001',
        country: 'India',
      },
      units: [
        {
          unitNumber: 'PH-01',
          floor: 10,
          carpetAreaSqFt: 3500,
          bedrooms: 4,
          bathrooms: 4,
        },
      ],
    });
    expect(valid.success).toBe(true);
  });
});
