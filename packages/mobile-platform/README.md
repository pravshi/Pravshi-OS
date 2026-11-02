# @pravshi/mobile-platform

Shared mobile foundational platform package for **Pravshi OS** (Phase 3).
Provides dynamic white-label theming, camera/document scanning contracts, zero-trust content-free push notification handling, and secure storage boundaries for native mobile applications.

## Modules

### 1. `ui`

- **Dynamic Theming Engine:** Driven by tenant white-label tokens (`WhiteLabelBrandingSchema`).
- **Accessible Color Contrast:** Automatic calculation of foreground luminance using YIQ contrast.
- **Cross-Platform Primitives:** Standardized layout, surface, and typography interfaces.
- **Brandable Mobile Components:**
  - `AppHeader`: Tenant-branded top navigation bar with back/action triggers and status badges.
  - `TenantBadge`: Visual indicator of the current tenant isolation boundary and environment.
  - `StatusPill`: Semantic status pill for CRM records, leads, tasks, and system events.
  - `OfflineBanner`: Sticky notification banner with pending mutation counts and sync retry.
  - `ActionButton`: Accessible theme-aware action button with variants and loading states.

### 2. `camera`

- **Document Scanning:** Multipage document intake with edge detection, auto-capture options, and image compression.
- **Barcode & QR Scanning:** Schema-validated scanner for tenant invites, session verification challenges, asset tracking tags, and CRM entity links.

### 3. `notifications`

- **Content-Free Push Handling:** Zero confidential business data or PII is sent across third-party push networks (APNs / FCM).
- **Secure API Fetch:** Devices receive an opaque UUID envelope and securely pull decrypted payloads over the authenticated API within the active tenant session.
- **Tenant Isolation:** Automatically rejects notifications directed to mismatched tenant IDs.

### 4. `storage`

- **Secure Enclave Interface (`ISecureEnclaveStorage`):** Hardware-backed Keychain (iOS) and Keystore (Android) for session tokens, refresh tokens, and HMAC signing keys. _Never use standard AsyncStorage / SQLite for secrets._
- **Tenant-Isolated Metadata Cache (`ITenantIsolatedCache`):** Structured, TTL-aware local storage strictly partitioned by `tenantId` for read-only caches and offline mutation queues.

## Usage

```typescript
import {
  ThemeProvider,
  AppHeader,
  ActionButton,
  PushNotificationHandler,
  TenantIsolatedMemoryCache,
} from '@pravshi/mobile-platform';
```
