import type { NextConfig } from 'next';

/**
 * Security headers, applied to every route.
 *
 * - HSTS: two years, subdomains, preload-ready. Only meaningful over HTTPS;
 *   harmless on http://localhost, where browsers simply ignore it.
 * - CSP: locked to 'self' with 'unsafe-inline' for scripts and styles, which
 *   Next.js 15 requires in production (inline hydration scripts, Tailwind's
 *   runtime style injection). No external script/style sources exist in this
 *   app, so nothing legitimate is blocked. frame-ancestors 'none' backs the
 *   X-Frame-Options header for browsers that prefer CSP.
 *   Phase 11 (F-11-12) disposition on 'unsafe-inline': retained deliberately,
 *   not silently accepted. Removing it needs nonce-based CSP served from
 *   middleware, which this app does not have; that is a Phase 13 candidate
 *   with its own verification pass (phase11-architecture-audit.md §6 Q3).
 *   The mitigations standing behind it today are React's escaping, no
 *   dangerouslySetInnerHTML in the app, and the workflow no-eval guard.
 * - connect-src additionally allows the Sentry ingest hosts so the browser
 *   SDK can actually report when NEXT_PUBLIC_SENTRY_DSN is configured —
 *   under 'self' alone its events were silently dropped. With no DSN set
 *   the SDK never loads and these hosts are simply unused.
 * - Permissions-Policy denies the browser capabilities this app never uses
 *   (camera, microphone, geolocation, payment), so a compromised or embedded
 *   frame cannot reach for them either.
 * - X-Frame-Options DENY, nosniff, and a conservative referrer policy round
 *   out the set.
 */
/**
 * The Next.js DEVELOPMENT server evaluates its own modules with eval() (React Refresh and
 * eval-based source maps). Without 'unsafe-eval' the browser blocks every client
 * component, so pages that render client-side — /setup, the login form's submit — never
 * appear under `pnpm dev`. Production builds never use eval(), so production keeps the
 * stricter policy; tests/guards/security-headers-ratelimit.test.ts proves both halves.
 * The app itself uses no eval (see the workflow no-eval guard).
 */
const isDevelopment = process.env.NODE_ENV === 'development';

const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      isDevelopment
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig: NextConfig = {
  /*
   * Sentry's Node SDK loads OpenTelemetry, which patches modules at runtime via
   * `require-in-the-middle`. That instrumentation only works if Node resolves these
   * packages itself, so they must not be bundled by webpack.
   *
   * Note this does NOT silence the build warning "Critical dependency: require
   * function is used in a way in which dependencies cannot be statically extracted".
   * That warning is emitted while webpack analyses the dependency graph, is a known
   * and harmless consequence of OpenTelemetry's dynamic requires, and the build
   * succeeds. It appeared when Sentry was added and is expected to stay.
   */
  serverExternalPackages: ['@sentry/node', '@opentelemetry/instrumentation'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
