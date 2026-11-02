/**
 * @pravshi/white-label-platform
 *
 * White-Label Mobile & Web Platform for Pravshi OS (Blueprint §12).
 *
 * Provides:
 * - Strict schema validation for tenant branding manifests
 * - Opaque build profiles for iOS & Android distribution (zero raw secrets)
 * - Version governance, minimum version gates, and instant suspension killswitch
 * - Immutable theme compilation for native and web runtimes
 * - Domain events for CI/CD compilation and deprecation broadcast
 */

export * from './domain';
export * from './application';
export * from './contracts';
