import { z } from 'zod';
import { DEAL_STAGES, COMPANY_SIZES, ACTIVITY_TYPES, ACTIVITY_ENTITY_TYPES } from './types';

/**
 * Client-side form validation — camelCase wire contract matching the server
 * schemas in src/lib/crm/schema.ts (PR #31). The server actions remain the
 * source of truth; these add UI-friendly messages and input normalization.
 */

const uuid = z.string().uuid();

/** Text input normalization: '' / whitespace-only → undefined, else trimmed. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : undefined;
    });

const optionalEmail = z
  .string()
  .max(254)
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  })
  .pipe(z.string().email('Enter a valid email').optional());

export const CompanyFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  domain: optionalText(253),
  industry: optionalText(100),
  size: z.enum(COMPANY_SIZES).optional(),
  website: optionalText(500),
  phone: optionalText(50),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  addressCity: optionalText(100),
  addressState: optionalText(100),
  addressPostalCode: optionalText(20),
  countryCode: z.string().trim().toUpperCase().length(2, 'Country code must be 2 letters'),
});

export const ContactFormSchema = z.object({
  companyId: uuid.optional(),
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: optionalEmail,
  phone: optionalText(50),
  title: optionalText(150),
  department: optionalText(100),
});

export const DealFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    companyId: uuid.optional(),
    contactId: uuid.optional(),
    value: z
      .string()
      .max(24)
      .optional()
      .transform((v) => {
        const t = v?.trim();
        return t ? t : undefined;
      })
      .pipe(
        z
          .string()
          .regex(/^\d+(\.\d{1,4})?$/, 'Enter a non-negative amount')
          .optional(),
      ),
    currency: z.string().trim().toUpperCase().length(3, 'Currency must be a 3-letter code'),
    stage: z.enum(DEAL_STAGES),
    probability: z
      .string()
      .max(3)
      .optional()
      .transform((v) => {
        const t = v?.trim();
        return t ? t : undefined;
      })
      .refine((v) => v === undefined || /^\d{1,3}$/.test(v), 'Probability must be a whole number')
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine((v) => v === undefined || (v >= 0 && v <= 100), 'Must be between 0 and 100'),
    expectedCloseDate: z
      .string()
      .optional()
      .transform((v) => {
        const t = v?.trim();
        return t ? t : undefined;
      })
      .pipe(
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional(),
      ),
  })
  .superRefine((deal, ctx) => {
    // A contact must belong to the deal's company (the migration enforces the
    // pairing at the database level); the UI refuses a mismatched pair early.
    if (deal.contactId && !deal.companyId) {
      ctx.addIssue({
        code: 'custom',
        path: ['companyId'],
        message: 'Pick a company when a contact is set — the contact must belong to it.',
      });
    }
  });

export type CompanyFormInput = z.infer<typeof CompanyFormSchema>;
export type ContactFormInput = z.infer<typeof ContactFormSchema>;
export type DealFormInput = z.infer<typeof DealFormSchema>;

// ── Activities (Phase 2 Track B) ───────────────────────────────────────────────

/**
 * datetime-local input normalization: '' → undefined, else the instant as a
 * full ISO string (the server boundary validates ISO-8601 datetimes strictly).
 */
const optionalDateTimeIso = z
  .string()
  .max(64)
  .optional()
  .transform((v) => {
    const t = v?.trim();
    if (!t) return undefined;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? t : new Date(ms).toISOString();
  })
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
    message: 'Enter a valid date and time',
  });

export const ActivityFormSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().trim().min(1, 'Subject is required').max(200),
  notes: optionalText(4000),
  occurredAt: optionalDateTimeIso,
  dueAt: optionalDateTimeIso,
});

export type ActivityFormInput = z.infer<typeof ActivityFormSchema>;

/** The entity pickers on the standalone new-activity page. */
export const ActivityEntityPickerSchema = z.object({
  entityType: z.enum(ACTIVITY_ENTITY_TYPES),
  entityId: uuid,
});

export type ActivityEntityPickerInput = z.infer<typeof ActivityEntityPickerSchema>;
