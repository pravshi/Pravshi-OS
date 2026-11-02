/**
 * White-Label Platform Contracts — Public Domain Events.
 *
 * Emitted across the domain events port for mobile CI/CD pipeline triggers
 * and client version obsolescence broadcasting.
 */

export interface AppBuildRequestedEvent {
  readonly type: 'white_label.build.requested';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly buildId: string;
    readonly platform: 'ios' | 'android' | 'all';
    readonly bundleId: string;
    readonly manifestVersion: number;
    readonly environment: 'production' | 'staging';
  };
}

export interface AppVersionDeprecatedEvent {
  readonly type: 'white_label.version.deprecated';
  readonly organizationId: string;
  readonly actorId: string;
  readonly timestamp: string;
  readonly payload: {
    readonly platform: 'ios' | 'android';
    readonly minimumSupportedVersion: string;
    readonly forcedUpgrade: boolean;
    readonly upgradeUrl: string;
  };
}

export type WhiteLabelEvent = AppBuildRequestedEvent | AppVersionDeprecatedEvent;
