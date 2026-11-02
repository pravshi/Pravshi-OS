import { describe, expect, it } from 'vitest';
import {
  resolveTenantTheme,
  DefaultLightTheme,
  type WhiteLabelBranding,
  ContentFreePushEnvelopeSchema,
  PravshiQrPayloadSchema,
} from '@pravshi/mobile-platform';

describe('Mobile Platform: Shared Primitives & Contracts', () => {
  it('resolves default theme tokens when no tenant branding is supplied', () => {
    const theme = resolveTenantTheme();
    expect(theme.mode).toBe('light');
    expect(theme.colors.primary).toBe(DefaultLightTheme.colors.primary);
  });

  it('dynamically adapts tenant white-label branding tokens and computes contrast', () => {
    const branding: WhiteLabelBranding = {
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      organizationName: 'Apex Estates',
      primaryColor: '#0369a1',
      secondaryColor: '#f59e0b',
      accentColor: '#10b981',
      borderRadiusBase: 12,
    };

    const darkTheme = resolveTenantTheme(branding, 'dark');
    expect(darkTheme.mode).toBe('dark');
    expect(darkTheme.colors.primary).toBe('#0369a1');
    expect(darkTheme.borderRadius.md).toBe(12);
  });

  it('validates content-free push notification envelopes', () => {
    const validEnvelope = {
      notificationId: '123e4567-e89b-12d3-a456-426614174001',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      eventType: 'TASK_ASSIGNED',
      badge: 3,
      sentAt: Date.now(),
      silent: false,
    };

    const parsed = ContentFreePushEnvelopeSchema.safeParse(validEnvelope);
    expect(parsed.success).toBe(true);

    // Rejects invalid tenantId
    const badParse = ContentFreePushEnvelopeSchema.safeParse({
      ...validEnvelope,
      tenantId: 'not-a-uuid',
    });
    expect(badParse.success).toBe(false);
  });

  it('validates QR / Barcode scanned payloads', () => {
    const validQr = {
      type: 'DEAL_OR_PROJECT',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      entityType: 'deal',
      entityId: '123e4567-e89b-12d3-a456-426614174002',
    };

    const parsed = PravshiQrPayloadSchema.safeParse(validQr);
    expect(parsed.success).toBe(true);
  });
});
