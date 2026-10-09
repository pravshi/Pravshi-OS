import 'dotenv/config';
// Inert unless CI sets NEON_LOCAL_WSPROXY: points the Neon driver at CI's local Postgres.
import '../scripts/ci/neon-local.mjs';
