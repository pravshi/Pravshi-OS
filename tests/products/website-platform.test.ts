import { describe, expect, it } from 'vitest';
import {
  validateSubdomain,
  validateVerificationTransition,
  generateDomainVerificationToken,
  toPublicListingProjection,
  sanitizeInput,
  verifyHoneypot,
  verifyTimeGate,
} from '@pravshi/website-platform';

describe('Website Platform: Domain Rules & Projections', () => {
  it('validates subdomain rules and rejects reserved words', () => {
    expect(() => validateSubdomain('my-agency')).not.toThrow();
    expect(() => validateSubdomain('admin')).toThrow(/reserved/i);
    expect(() => validateSubdomain('api')).toThrow(/reserved/i);
    expect(() => validateSubdomain('-invalid-')).toThrow(/lowercase letters, numbers/i);
  });

  it('validates custom domain verification state transitions', () => {
    expect(() => validateVerificationTransition('pending', 'verified')).not.toThrow();
    expect(() => validateVerificationTransition('verified', 'active')).not.toThrow();
    expect(() => validateVerificationTransition('pending', 'active')).toThrow(
      /invalid domain verification transition/i,
    );
  });

  it('generates cryptographic DNS TXT challenge token', () => {
    const record = generateDomainVerificationToken('properties.example.com', 'site-1');
    expect(record.recordType).toBe('TXT');
    expect(record.host).toBe('_pravshi-challenge.properties.example.com');
    expect(record.token).toMatch(/^pravshi-site-verification-[a-f0-9]{32}$/);
  });

  it('strictly filters private fields and PII in public projections', () => {
    const rawListing = {
      id: 'l-1',
      title: 'Grand Villa',
      slug: 'grand-villa',
      description: 'Stunning property with scenic views',
      category: 'sale',
      propertyType: 'villa',
      pricing: { basePrice: 20_000_000, currency: 'INR', negotiable: true },
      location: {
        addressLine1: 'Private Owner Lane 4',
        city: 'Hyderabad',
        state: 'Telangana',
        postalCode: '500081',
        country: 'India',
      },
      units: [
        {
          id: 'u-1',
          unitNumber: 'V-01',
          floor: 1,
          carpetAreaSqFt: 4500,
          bedrooms: 5,
          bathrooms: 5,
          isAvailable: true,
        },
      ],
      amenities: ['Swimming Pool', 'Clubhouse'],
      images: ['https://cdn.example.com/photo.jpg'],
      // Private fields:
      ownerPersonalPhone: '+919999999999',
      commissionSplitPercent: 2.5,
      brokerNotes: 'Seller urgently looking to liquidate',
    };

    const publicDto = toPublicListingProjection(rawListing);
    expect(publicDto.title).toBe('Grand Villa');
    expect(publicDto.city).toBe('Hyderabad');
    expect((publicDto as unknown as Record<string, unknown>).ownerPersonalPhone).toBeUndefined();
    expect(
      (publicDto as unknown as Record<string, unknown>).commissionSplitPercent,
    ).toBeUndefined();
    expect((publicDto as unknown as Record<string, unknown>).brokerNotes).toBeUndefined();
  });

  it('enforces edge anti-abuse checks', () => {
    // Honeypot: must be empty
    expect(() => verifyHoneypot({ hp_field_check: '' })).not.toThrow();
    expect(() => verifyHoneypot({ hp_field_check: 'spammer_bot_filled_this' })).toThrow(/bot/i);

    // Timegate: submissions under 1.5 seconds are flagged
    expect(() => verifyTimeGate(Date.now() - 5000)).not.toThrow();
    expect(() => verifyTimeGate(Date.now() - 500)).toThrow(/bot/i);

    // Sanitization: strips dangerous script tags and event handlers
    const clean = sanitizeInput('<script>alert("xss")</script>Hello World');
    expect(clean).not.toContain('<script>');
    expect(clean).toContain('Hello World');
  });
});
