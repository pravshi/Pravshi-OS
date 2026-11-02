/**
 * Pravshi OS  Mobile Platform Content-Free Push Notification Handler.
 *
 * Enforces zero-trust isolation on push events:
 * 1. Validates the incoming content-free push envelope.
 * 2. Checks active tenant session alignment (rejects or quarantines mismatched tenant pushes).
 * 3. Fetches the authenticated full payload directly from Pravshi OS API via secure enclave credentials.
 * 4. Displays the notification locally on device without ever leaking payload to APNs / FCM.
 */

import {
  ContentFreePushEnvelopeSchema,
  type ContentFreePushEnvelope,
  type FullNotificationPayload,
  type ILocalNotificationPresenter,
  type IPushNotificationApiClient,
} from './types';

export interface PushHandlerConfig {
  apiClient: IPushNotificationApiClient;
  presenter: ILocalNotificationPresenter;
  getActiveTenantId: () => string | null;
  onNotificationReceived?: (payload: FullNotificationPayload) => void;
}

export class PushNotificationHandler {
  constructor(private readonly config: PushHandlerConfig) {}

  /**
   * Primary entry point invoked when OS delivers a background or foreground push.
   */
  async handleRawPushPayload(rawPayload: unknown): Promise<{
    processed: boolean;
    reason?: string;
    payload?: FullNotificationPayload;
  }> {
    const parseResult = ContentFreePushEnvelopeSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      return {
        processed: false,
        reason: `Invalid content-free push envelope: ${parseResult.error.message}`,
      };
    }

    const envelope = parseResult.data;
    return this.processEnvelope(envelope);
  }

  /**
   * Processes a verified content-free envelope with tenant isolation checks.
   */
  async processEnvelope(envelope: ContentFreePushEnvelope): Promise<{
    processed: boolean;
    reason?: string;
    payload?: FullNotificationPayload;
  }> {
    const activeTenantId = this.config.getActiveTenantId();

    // Verify tenant boundary
    if (!activeTenantId) {
      return {
        processed: false,
        reason: 'No active session or logged out; ignoring notification.',
      };
    }

    if (activeTenantId.toLowerCase() !== envelope.tenantId.toLowerCase()) {
      return {
        processed: false,
        reason: `Tenant mismatch: active is ${activeTenantId}, push is for ${envelope.tenantId}. Notification dropped.`,
      };
    }

    try {
      // Fetch full confidential payload securely over API
      const fullPayload = await this.config.apiClient.fetchNotificationPayload(
        envelope.tenantId,
        envelope.notificationId,
      );

      // Present locally on device
      if (!envelope.silent) {
        await this.config.presenter.presentLocalNotification(fullPayload);
      }

      if (envelope.badge !== undefined) {
        await this.config.presenter.setBadgeCount(envelope.badge);
      }

      // Acknowledge receipt back to server
      await this.config.apiClient.acknowledgeNotificationReceipt(
        envelope.tenantId,
        envelope.notificationId,
      );

      this.config.onNotificationReceived?.(fullPayload);

      return {
        processed: true,
        payload: fullPayload,
      };
    } catch (err) {
      return {
        processed: false,
        reason: `Failed to fetch notification payload from API: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
