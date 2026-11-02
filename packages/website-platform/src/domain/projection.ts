/**
 * Website Platform Domain — Public Projection Engine & PII Filtering.
 *
 * Implements strict projection allowlists. Guarantees that sensitive internal
 * enterprise data (broker splits, tenant screening notes, fee arrears, margins, contact PII)
 * NEVER leaks into public website SSR, CDN, or client bundles under Blueprint §13.
 */

export interface PublicListingProjection {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly propertyType: string;
  readonly category: string;
  readonly basePrice: number;
  readonly currency: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
  readonly landmark?: string;
  readonly unitsSummary: readonly {
    readonly unitNumber: string;
    readonly floor: number;
    readonly carpetAreaSqFt: number;
    readonly bedrooms: number;
    readonly bathrooms: number;
    readonly isAvailable: boolean;
  }[];
  readonly amenities: readonly string[];
  readonly images: readonly string[];
}

export interface PublicProgramProjection {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly degreeLevel: string;
  readonly department: string;
  readonly durationMonths: number;
  readonly totalCredits: number;
  readonly tuitionFee: number;
  readonly currency: string;
  readonly courses: readonly {
    readonly courseCode: string;
    readonly title: string;
    readonly credits: number;
    readonly isElective: boolean;
  }[];
}

/**
 * Strictly projects a raw internal listing into an allowlisted public representation.
 * Explicitly excludes internal pricing negotiation, owner contact details, broker commission,
 * and operational metadata.
 */
export function toPublicListingProjection(internalListing: {
  id: string;
  title: string;
  slug: string;
  description: string;
  propertyType: string;
  category: string;
  pricing: { basePrice: number; currency: string; negotiable?: boolean };
  location: { city: string; state: string; postalCode: string; country: string; landmark?: string };
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
}): PublicListingProjection {
  return {
    id: internalListing.id,
    title: internalListing.title,
    slug: internalListing.slug,
    description: internalListing.description,
    propertyType: internalListing.propertyType,
    category: internalListing.category,
    basePrice: internalListing.pricing.basePrice,
    currency: internalListing.pricing.currency,
    city: internalListing.location.city,
    state: internalListing.location.state,
    postalCode: internalListing.location.postalCode,
    country: internalListing.location.country,
    landmark: internalListing.location.landmark,
    unitsSummary: (internalListing.units ?? []).map((u) => ({
      unitNumber: u.unitNumber,
      floor: u.floor,
      carpetAreaSqFt: u.carpetAreaSqFt,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      isAvailable: u.isAvailable,
    })),
    amenities: internalListing.amenities ?? [],
    images: internalListing.images ?? [],
  };
}

/**
 * Strictly projects an internal academic program into an allowlisted public representation.
 * Eliminates applicant rosters, margin estimates, or internal faculty contact data.
 */
export function toPublicProgramProjection(internalProgram: {
  id: string;
  code: string;
  name: string;
  degreeLevel: string;
  department: string;
  durationMonths: number;
  totalCredits: number;
  tuitionFee: number;
  currency: string;
  courses?: readonly {
    courseCode: string;
    title: string;
    credits: number;
    isElective: boolean;
  }[];
}): PublicProgramProjection {
  return {
    id: internalProgram.id,
    code: internalProgram.code,
    name: internalProgram.name,
    degreeLevel: internalProgram.degreeLevel,
    department: internalProgram.department,
    durationMonths: internalProgram.durationMonths,
    totalCredits: internalProgram.totalCredits,
    tuitionFee: internalProgram.tuitionFee,
    currency: internalProgram.currency,
    courses: (internalProgram.courses ?? []).map((c) => ({
      courseCode: c.courseCode,
      title: c.title,
      credits: c.credits,
      isElective: c.isElective,
    })),
  };
}
