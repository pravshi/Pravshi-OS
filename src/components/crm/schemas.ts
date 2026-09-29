import { z } from 'zod';
import { DEAL_STAGES, COMPANY_SIZES } from './types';

/**
 * Client-side form validation — TEMPORARY DUPLICATION.
 *
 * These mirror the server schemas that PR #31 will provide in
 * src/lib/crm/schema.ts. After #31 merges, import the canonical schemas from
 * there and delete these (keeping any UI-only helpers). The server actions
 * remain the source of truth regardless.
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
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postal_code: optionalText(20),
  country_code: z.string().trim().toUpperCase().length(2, 'Country code must be 2 letters'),
});

export const ContactFormSchema = z.object({
  company_id: uuid.optional(),
  first_name: z.string().trim().min(1, 'First name is required').max(100),
  last_name: optionalText(100),
  email: optionalEmail,
  phone: optionalText(50),
  title: optionalText(150),
  department: optionalText(100),
});

export const DealFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    company_id: uuid.optional(),
    contact_id: uuid.optional(),
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
    expected_close_date: z
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
    // A contact must belong to the deal's company (migration 0031 enforces the
    // pairing at the database level); the UI refuses a mismatched pair early.
    if (deal.contact_id && !deal.company_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['company_id'],
        message: 'Pick a company when a contact is set — the contact must belong to it.',
      });
    }
  });

export type CompanyFormInput = z.infer<typeof CompanyFormSchema>;
export type ContactFormInput = z.infer<typeof ContactFormSchema>;
export type DealFormInput = z.infer<typeof DealFormSchema>;
