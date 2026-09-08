import type { NextConfig } from 'next';

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
};

export default nextConfig;
