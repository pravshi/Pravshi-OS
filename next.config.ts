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
 * - X-Frame-Options DENY, nosniff, and a conservative referrer policy round
 *   out the set.
 */
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
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
