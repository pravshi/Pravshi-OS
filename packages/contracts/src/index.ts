/**
 * Pravshi OS — Shared API and Inter-app Contracts (Step 8, package 7).
 *
 * Public request/response schemas and transport envelopes shared across applications,
 * background workers, and future product modules.
 */
import { z } from 'zod';

export const UuidSchema = z.string().uuid();

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
