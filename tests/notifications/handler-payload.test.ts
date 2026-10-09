/**
 * Phase 8 — notification job-handler payload extension: pure unit tests.
 *
 * Covers the Phase-8 additions to normalizeNotificationPayload (type/eventId
 * folded out of data). The worker-plane SQL path itself needs a live DB and
 * is covered by the integration pass.
 */
import { describe, expect, it } from 'vitest';
import { normalizeNotificationPayload } from '@/lib/jobs/handlers';

describe('normalizeNotificationPayload — Phase 8 type/eventId', () => {
  it('reads type and eventId from data', () => {
    const n = normalizeNotificationPayload({
      personId: '11111111-1111-4111-8111-111111111111',
      title: 't',
      message: 'b',
      data: { type: 'DEAL_STAGE_CHANGED', eventId: 'evt-42', entityType: 'deal' },
    });
    expect(n.type).toBe('DEAL_STAGE_CHANGED');
    expect(n.eventId).toBe('evt-42');
    expect(n.data['entityType']).toBe('deal');
  });

  it('defaults type to SYSTEM_ALERT and eventId to null when absent', () => {
    const n = normalizeNotificationPayload({
      title: 't',
      message: 'b',
    });
    expect(n.type).toBe('SYSTEM_ALERT');
    expect(n.eventId).toBeNull();
    expect(n.personId).toBeNull();
  });

  it('sanitizes malformed type/eventId instead of failing', () => {
    const n = normalizeNotificationPayload({
      title: 't',
      message: 'b',
      data: { type: '   ', eventId: '' },
    });
    expect(n.type).toBe('SYSTEM_ALERT');
    expect(n.eventId).toBeNull();

    const overlong = normalizeNotificationPayload({
      title: 't',
      message: 'b',
      data: { type: 'x'.repeat(65), eventId: 'y'.repeat(257) },
    });
    expect(overlong.type).toBe('SYSTEM_ALERT');
    expect(overlong.eventId).toBeNull();
  });

  it('keeps the alias shape working (type defaults)', () => {
    const n = normalizeNotificationPayload({
      recipientPersonId: '11111111-1111-4111-8111-111111111111',
      title: 't',
      body: 'b',
      entityType: 'task',
      entityId: 'task-1',
    });
    expect(n.type).toBe('SYSTEM_ALERT');
    expect(n.eventId).toBeNull();
    expect(n.message).toBe('b');
    expect(n.data['entityType']).toBe('task');
  });
});
