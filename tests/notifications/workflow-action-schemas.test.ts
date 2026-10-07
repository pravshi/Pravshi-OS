/**
 * Phase 8 — workflow send_notification / send_email param schemas (no DB).
 *
 * The executors enqueue Phase-6 jobs under the trigger actor's authority;
 * enqueueing needs a live DB + jobs.create, so execution itself is covered
 * by the integration pass. These tests pin the save/execution-time contracts.
 */
import { describe, expect, it } from 'vitest';
import { SendEmailParamsSchema, SendNotificationParamsSchema } from '@/lib/workflows/actions';
import { ActionConfigSchema } from '@/lib/workflows/schema';

const PERSON = '55555555-5555-4555-8555-555555555555';

describe('SendNotificationParamsSchema', () => {
  it('accepts a full valid config', () => {
    const parsed = SendNotificationParamsSchema.safeParse({
      recipientPersonId: PERSON,
      title: 'Deal won',
      body: '{{deal.title}} just closed',
      eventType: 'DEAL_STAGE_CHANGED',
      entityType: 'deal',
      entityId: 'deal-1',
      link: '/deals/deal-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a {{template}} recipient (resolved at execution)', () => {
    const parsed = SendNotificationParamsSchema.safeParse({
      recipientPersonId: '{{deal.ownerPersonId}}',
      title: 't',
      body: 'b',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing recipient/title/body and unknown event types', () => {
    expect(SendNotificationParamsSchema.safeParse({ title: 't', body: 'b' }).success).toBe(false);
    expect(
      SendNotificationParamsSchema.safeParse({
        recipientPersonId: PERSON,
        title: 't',
        body: 'b',
        eventType: 'BOGUS',
      }).success,
    ).toBe(false);
  });
});

describe('SendEmailParamsSchema', () => {
  it('accepts a single address and an address list', () => {
    expect(
      SendEmailParamsSchema.safeParse({
        to: 'ops@example.com',
        subject: 's',
        body: 'b',
      }).success,
    ).toBe(true);
    expect(
      SendEmailParamsSchema.safeParse({
        to: ['a@example.com', 'b@example.com'],
        subject: 's',
        body: 'b',
        bodyHtml: '<p>b</p>',
      }).success,
    ).toBe(true);
  });

  it('accepts a {{template}} recipient', () => {
    expect(
      SendEmailParamsSchema.safeParse({
        to: '{{person.workEmail}}',
        subject: 's',
        body: 'b',
      }).success,
    ).toBe(true);
  });

  it('rejects invalid addresses and empty bodies', () => {
    expect(
      SendEmailParamsSchema.safeParse({ to: 'not-an-email', subject: 's', body: 'b' }).success,
    ).toBe(false);
    expect(
      SendEmailParamsSchema.safeParse({ to: 'a@example.com', subject: 's', body: '' }).success,
    ).toBe(false);
  });
});

describe('ActionConfigSchema (Phase 8 save-time gap fix)', () => {
  const PERSON = '55555555-5555-4555-8555-555555555555';

  it('accepts send_notification with valid params', () => {
    const parsed = ActionConfigSchema.safeParse({
      type: 'send_notification',
      params: {
        recipientPersonId: PERSON,
        title: 'Deal won',
        body: '{{deal.title}} just closed',
        eventType: 'DEAL_STAGE_CHANGED',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts send_email with valid params', () => {
    const parsed = ActionConfigSchema.safeParse({
      type: 'send_email',
      params: { to: 'ops@example.com', subject: 's', body: 'b' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects send_notification/send_email with invalid params (not silently)', () => {
    expect(
      ActionConfigSchema.safeParse({
        type: 'send_notification',
        params: { title: 't', body: 'b' }, // missing recipientPersonId
      }).success,
    ).toBe(false);
    expect(
      ActionConfigSchema.safeParse({
        type: 'send_email',
        params: { to: 'not-an-email', subject: 's', body: 'b' },
      }).success,
    ).toBe(false);
  });

  it('still rejects the truly-deferred webhook/run_ai_action with a clear message', () => {
    for (const type of ['webhook', 'run_ai_action']) {
      const parsed = ActionConfigSchema.safeParse({ type, params: {} });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]!.message).toMatch(/registry-documented only/);
      }
    }
  });

  it('still rejects unknown action types', () => {
    expect(ActionConfigSchema.safeParse({ type: 'teleport', params: {} }).success).toBe(false);
  });

  it('still accepts the six Phase-5 action types', () => {
    expect(
      ActionConfigSchema.safeParse({
        type: 'create_task',
        params: { title: 't' },
      }).success,
    ).toBe(true);
  });
});
