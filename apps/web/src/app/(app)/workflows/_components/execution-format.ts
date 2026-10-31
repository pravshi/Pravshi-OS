/**
 * Client-safe formatting helpers for the executions UI (A14).
 *
 * Kept separate from the builder track's _types.ts so the detail track never
 * edits A13's file. Pure functions, no imports.
 */

/** "1.2 s" / "340 ms" / "—". */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Short error excerpt for table cells; the full text lives in ExecutionDetail. */
export function errorExcerpt(message: string | null | undefined, max = 80): string {
  if (!message) return '—';
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
