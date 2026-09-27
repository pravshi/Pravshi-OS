/**
 * Curated list of the most commonly used passwords, for the local breach check.
 *
 * This is the always-on half of the compromised-password defense (blueprint
 * section 25: the breach-list check belongs on every path that accepts a new
 * password). Matching is exact and case-insensitive — a password that IS one of
 * these, letter for letter, is rejected. The HIBP k-anonymity lookup is the
 * networked half; when it is unreachable the flow fails open but this list still
 * applies.
 *
 * Sources: widely published analyses of breached-password corpora (SplashData,
 * NordPass annual lists, SecLists' 10k most common). Curated, not exhaustive —
 * the HIBP lookup covers the long tail.
 */
const COMMON_PASSWORDS = new Set([
  'password', '123456', '123456789', '12345678', '12345', '1234567', '1234567890',
  'qwerty', 'abc123', 'password1', '123123', 'admin', 'letmein', 'welcome',
  'monkey', 'dragon', '1234', 'qwerty123', 'football', 'master', 'login',
  'princess', 'solo', 'qwertyuiop', 'starwars', '654321', 'superman', 'trustno1',
  'whatever', 'freedom', '1q2w3e4r', '1qaz2wsx', 'baseball', 'michael',
  'shadow', 'sunshine', 'jordan', 'harley', 'passw0rd', 'p@ssw0rd', 'password123',
  'iloveyou', 'changeme',
]);

/** Exact, case-insensitive match against the curated common-password list. */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
