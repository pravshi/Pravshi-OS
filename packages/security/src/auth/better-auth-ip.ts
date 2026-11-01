import {
  CLIENT_ADDRESS_HEADER,
  clientAddressSource,
  type ClientAddressSource,
} from '@/lib/observability/client-address';

/**
 * Better Auth's own address resolution, made to agree with the application's. With no trusted
 * header the list is empty, never disableIpTracking: Better Auth then resolves no address and
 * keys its limiter on one shared no-trusted-ip bucket, whereas disableIpTracking switches its
 * limiter off entirely (better-auth 1.7.14 rate-limiter: no address + disableIpTracking → no
 * limit).
 */
export function betterAuthIpAddressOptions(source: ClientAddressSource = clientAddressSource()) {
  const name = CLIENT_ADDRESS_HEADER[source];
  return { ipAddressHeaders: name ? [name] : [] };
}
