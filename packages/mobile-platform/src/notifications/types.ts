/**
 * Pravshi OS  Mobile Platform Push Notification Contracts.
 *
 * Implements content-free push notification models to protect tenant data confidentiality
 * across third-party delivery channels (APNs / FCM).
 */

import { z } from 'zod';

/**
 * The bare envelope transported over APNs or FCM.
 * NEVER contains PII, sensitive message bodies, lead names, or client details.
 */
export const ContentFreePushEnvelopeSchema = z.object({
  notificationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  eventType: z.enum([
    'TASK_ASSIGNED',
    'TASK_UPDATED',
    'DEAL_STAGE_CHANGED',
    'SECURITY_ALERT',
    'WORKFLOW_APPROVAL_REQUEST',
    'SYSTEM_MAINTENANCE',
  ]),
  badge: z.number().int().nonnegative().optional(),
  sentAt: z.number().int().positive(),
  silent: z.boolean().default(false),
});

export type ContentFreePushEnvelope = z.infer<typeof ContentFreePushEnvelopeSchema>;

/**
 * Full notification payload retrieved securely over the authenticated API
 * within the active tenant session.
 */
export const FullNotificationPayloadSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  eventType: z.string(),
  title: z.string().min(1),
  body: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  category: z.string().optional(),
  actionUrl: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type FullNotificationPayload = z.infer<typeof FullNotificationPayloadSchema>;

export interface DevicePushRegistration {
  devicePushToken: string;
  platform: 'ios' | 'android';
  tenantId: string;
  appVersion: string;
  osVersion: string;
  registeredAt: number;
}

export interface IPushNotificationApiClient {
  fetchNotificationPayload(
    tenantId: string,
    notificationId: string,
  ): Promise<FullNotificationPayload>;
  acknowledgeNotificationReceipt(tenantId: string, notificationId: string): Promise<void>;
  registerDeviceToken(registration: DevicePushRegistration): Promise<{ registered: boolean }>;
}

export interface ILocalNotificationPresenter {
  presentLocalNotification(payload: FullNotificationPayload): Promise<void>;
  setBadgeCount(count: number): Promise<void>;
}
