import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('never touches the database — an uptime monitor must not become a keep-alive', () => {
    const src = readFileSync('src/app/health/route.ts', 'utf8');
    expect(src).not.toMatch(/from ['"]@\/lib\/db/);
    expect(src).not.toMatch(/neondatabase/);
  });

  it('documents that /health/db is not for monitors and requires a token', () => {
    const src = readFileSync('src/app/health/db/route.ts', 'utf8');
    expect(src).toMatch(/not for uptime monitors/i);
    expect(src).toMatch(/x-pravshi-health-token/);
  });
});
