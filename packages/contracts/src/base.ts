/**
 * Pravshi OS — Shared Base Primitives & Envelopes (Layer 3).
 *
 * Fundamental scalar schemas, safe money representation, and transport envelopes
 * shared across all contracts without circular dependencies.
 */
import { z } from 'zod';

export const UuidSchema = z.string().uuid('Must be a valid UUIDv4');

/**
 * Validates actual calendar dates in YYYY-MM-DD format (rejects 2026-02-31, 2026-11-31, etc.).
 */
export const CalendarDateSchema = z.string().refine(
  (val) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
    const [year, month, day] = val.split('-').map(Number);
    if (!year || !month || !day) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  },
  { message: 'Must be a valid calendar date in YYYY-MM-DD format (e.g. 2026-02-28)' },
);

/**
 * Monetary values represented as non-negative safe integers in paise (1 INR = 100 paise).
 * Strictly enforces Number.isSafeInteger to prevent JavaScript floating-point arithmetic errors.
 */
export const MoneyPaiseSchema = z.number().refine((n) => Number.isSafeInteger(n) && n >= 0, {
  message: 'Monetary amounts must be non-negative safe integers (up to Number.MAX_SAFE_INTEGER)',
});

export type MoneyPaise = z.infer<typeof MoneyPaiseSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().optional(),
  });

export const ApiErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  message: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const ApiSuccessResponseSchema = <T extends z.ZodTypeAny>(dataSchema?: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema ?? z.unknown().optional(),
    message: z.string().optional(),
  });

export const DateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type DateRangeQuery = z.infer<typeof DateRangeQuerySchema>;
