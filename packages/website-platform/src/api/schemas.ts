/**
 * Website Platform API — Zod Validation Schemas and Public Inquiries.
 */

import { z } from 'zod';
import { PAGE_TEMPLATES, PAGE_STATUSES, CONTENT_BLOCK_TYPES } from '../domain/content';
import { sanitizeInput } from './anti-abuse';

export const CreateSiteSchema = z.object({
  subdomain: z.string().min(3).max(63),
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  primaryColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color')
    .default('#0f172a'),
  logoUrl: z.string().url().optional(),
});

export type CreateSiteInput = z.infer<typeof CreateSiteSchema>;

export const RequestDomainVerificationSchema = z.object({
  siteId: z.string().uuid(),
  customDomain: z
    .string()
    .min(4)
    .max(253)
    .regex(
      /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
      'Must be a valid FQDN domain',
    ),
});

export type RequestDomainVerificationInput = z.infer<typeof RequestDomainVerificationSchema>;

export const ContentBlockSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(CONTENT_BLOCK_TYPES),
  title: z.string().optional(),
  content: z.record(z.string(), z.unknown()),
  order: z.number().int().default(0),
});

export const SavePageContentSchema = z.object({
  siteId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  template: z.enum(PAGE_TEMPLATES),
  blocks: z.array(ContentBlockSchema),
  status: z.enum(PAGE_STATUSES).default('draft'),
});

export type SavePageContentInput = z.infer<typeof SavePageContentSchema>;

export const PublicInquirySchema = z.object({
  siteId: z.string().uuid(),
  entityType: z.enum(['listing', 'program', 'general']),
  entityId: z.string().uuid().optional(),
  name: z.string().min(2).max(100).transform(sanitizeInput),
  email: z.string().email(),
  phone: z.string().min(5).max(20).transform(sanitizeInput),
  message: z.string().min(5).max(2000).transform(sanitizeInput),
  hp_field_check: z.string().max(0, 'Bot detected').optional(),
  formRenderTimestamp: z.number().positive(),
});

export type PublicInquiryInput = z.infer<typeof PublicInquirySchema>;
