/**
 * The one-time bootstrap setup token format, shared between server and client.
 *
 * 32 bytes from a CSPRNG, base64url-encoded and unpadded — exactly what the
 * bootstrap script issues and prints as APP_URL/setup#token=… .
 *
 * This lives in its own module with no Node.js imports so the client-side
 * setup form can validate the token shape without pulling server-only
 * dependencies (e.g. node:crypto) into the browser bundle.
 */
export const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
