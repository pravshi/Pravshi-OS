# @pravshi/white-label-platform

White-label engine, manifest validation, distribution profile management, and client version governance platform for Pravshi OS (Blueprint §12).

## Core Capabilities

1. **Manifest Validation & Allowlisting (`src/domain/manifest.ts`, `src/application/validate-manifest.ts`)**:
   - Strict Zod schema for tenant branding (app name, reverse-domain bundle ID, HTTPS asset URLs, color hexes).
   - Zero Arbitrary Code Execution: Strict allowlist prevents CSS/JS injection or script execution inside native shell builds.
2. **Distribution Profiles with Zero Raw Secrets (`src/domain/build-profile.ts`)**:
   - Stores only opaque reference IDs to secret vaults for iOS provisioning and Android keystores.
   - Built-in scanner (`assertNoRawSecretsInProfile`) prevents raw certificates, private keys, or passwords from ever entering the tenant database or manifest payloads.
3. **Version Governance & Instant Suspension (`src/domain/version-governance.ts`)**:
   - Semantic version comparator with minimum supported version gates and forced upgrade directives.
   - Tenant killswitch: Instant suspension capability for compromised or retired client releases.
4. **Theme Compilation (`src/application/compile-theme.ts`)**:
   - Compiles tenant brand manifests into immutable design tokens for React Native and CSS variable sheets.
5. **Domain Events (`src/contracts/events.ts`)**:
   - `AppBuildRequestedEvent`, `AppVersionDeprecatedEvent`.

## Security Boundaries & Isolation

- **Layer 4 Separation**: Sits within tenant domain boundaries, isolating tenant asset configurations.
- **Zero Raw Secrets**: Keystores and Apple certificates reside exclusively in isolated CI/CD runners or vault hardware, referenced solely by opaque identifiers.
