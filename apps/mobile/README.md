# @pravshi/mobile

Cross-platform native mobile application for **Pravshi OS** (Phase 3).
Engineered for iOS and Android under Blueprint §05, §11, and §12.

## Architectural Overview

```
apps/mobile/
├── src/
│   ├── index.ts              # Package entry point
│   ├── app/                  # Navigation structure & screens
│   │   ├── routes.ts         # Strictly typed route registry
│   │   ├── navigation.ts     # Navigation controller & stack router
│   │   └── screens/
│   │       ├── AuthScreen.tsx            # Login, SSO & Biometric unlock
│   │       ├── DashboardScreen.tsx       # Core operations hub & telemetry
│   │       ├── TenantSwitcherScreen.tsx  # Multi-tenant switching & boundary enforcement
│   │       └── OfflineIndicatorScreen.tsx# Offline mutation queue inspector
│   ├── auth/                 # Authentication & Hardware Secure Storage
│   │   ├── secure-storage.ts # OS Secure Enclave (Keychain / Keystore)
│   │   └── session.ts        # Tenant context & session lifecycle state machine
│   └── api/                  # Network layer & offline synchronization
│       ├── client.ts         # Versioned API client (/api/v1/...) with signing & retry
│       └── offline-queue.ts  # Optimistic mutation queue & replay engine
└── README.md
```

## Security Boundaries & Guarantees

1. **Hardware Secure Enclave (`secure-storage.ts`):**
   - Authentication tokens (`accessToken`, `refreshToken`, HMAC signing seeds) are stored exclusively in the OS Secure Enclave (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on iOS and Android Keystore AES-256-GCM).
   - **CRITICAL INVARIANT:** Tokens are **NEVER** stored in unencrypted `AsyncStorage`, client-side SQLite, or plain text state files.

2. **Tenant Isolation Alignment:**
   - Every outgoing HTTP request injects `Authorization: Bearer <token>` and `X-Tenant-Id: <tenant-uuid>`.
   - The backend enforces transaction-local `withAuthorizedDb()` and PostgreSQL Row-Level Security (RLS) on all endpoints.
   - When switching tenants, cached tenant data is partitioned or purged, and a re-authentication challenge is issued.

3. **Request Signing & Anti-Replay:**
   - All mobile mutations carry `X-Signature`, `X-Timestamp`, and `X-Nonce` generated from a device signing key seed to protect against tampering and replay attacks over public networks.

4. **Zero-Trust Content-Free Push Notifications:**
   - In accordance with enterprise confidentiality standards, Apple Push Notification service (APNs) and Firebase Cloud Messaging (FCM) receive content-free envelopes containing only an opaque `notificationId` and `tenantId`.
   - The device wakes up, validates the active tenant session, and fetches the decrypted payload directly from the authenticated `/api/v1/notifications/:id/payload` endpoint before presenting locally.

## Offline Architecture & Optimistic Updates

- When offline, mutation operations (`POST`, `PUT`, `PATCH`, `DELETE`) are captured by `OfflineMutationQueue`.
- Each mutation is assigned an optimistic ID (`opt_temp_...`) and persisted into tenant-isolated storage.
- When network connectivity is restored, the queue replays operations sequentially with exponential backoff and idempotency keys (`Idempotency-Key`).
- Operations exceeding max retry thresholds are safely moved to a dead-letter queue for review.

## Expo Workflow & White-Label Consumption

- **Expo & EAS Build:** Designed for Expo Application Services (EAS) prebuild workflow utilizing custom config plugins for Keychain, Camera/Document Scanner, and Biometrics.
- **Dynamic White-Labeling:**
  - Tenants supply their custom brand tokens (`primaryColor`, `accentColor`, `borderRadius`, `logoUrl`) via the White-Label Platform.
  - The `@pravshi/mobile-platform` theming engine dynamically computes accessible text luminance (YIQ contrast) and updates colors across all UI components at runtime.
  - White-label partner apps can generate custom native app bundles with tenant-specific app icons and splash screens via EAS environment profiles.
