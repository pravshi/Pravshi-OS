import { describe, expect, it, vi } from 'vitest';

/**
 * The first-administrator setup email (src/lib/platform/setup-email.ts): the link goes into the
 * message and nowhere else — a failed or refused send logs the failure's name only, never the
 * link, the token or the address.
 */
const LINK =
  'https://os.pravshi.com/setup/organization#token=SENTINELtokenSENTINELtokenSENTINELtokenSE';
const send = vi.fn();

vi.mock('@/env', () => ({
  env: { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Pravshi <no-reply@example.test>' },
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const { buildOrgAdminSetupEmail, isSetupEmailConfigured, sendOrgAdminSetupEmail } =
  await import('@/lib/platform/setup-email');

const message = {
  to: 'founder@tenant.example',
  fullName: 'Tenant <Founder>',
  orgName: 'Acme & Co',
  link: LINK,
  expiresAt: new Date('2026-11-01T00:00:00Z'),
};

async function capture(run: () => Promise<unknown>) {
  const logged: unknown[] = [];
  const spies = (['error', 'warn', 'log', 'info'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a) => {
      logged.push(a);
    }),
  );
  try {
    return { result: await run(), logged };
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

describe('the setup email', () => {
  it('carries the link to the recipient, escaped, with its expiry', () => {
    const m = buildOrgAdminSetupEmail(message);
    expect(m.subject).toBe('Set up Acme & Co on Pravshi OS');
    expect(m.html).toContain(LINK);
    expect(m.html).toContain('Tenant &lt;Founder&gt;');
    expect(m.html).toContain('Acme &amp; Co');
    expect(m.text).toContain(LINK);
    expect(m.text).toContain('Sun, 01 Nov 2026');
    expect(isSetupEmailConfigured()).toBe(true);
  });

  it('a refused send logs only the error name', async () => {
    send.mockResolvedValueOnce({ error: { name: 'validation_error', message: `bad ${LINK}` } });
    const { result, logged } = await capture(() => sendOrgAdminSetupEmail(message));
    expect(result).toBe(false);
    expect(JSON.stringify(logged)).not.toContain('SENTINEL');
    expect(JSON.stringify(logged)).not.toContain('founder@tenant.example');
  });

  it('a thrown send logs only the error name', async () => {
    send.mockRejectedValueOnce(
      new Error(`network down while sending ${LINK} to founder@tenant.example`),
    );
    const { result, logged } = await capture(() => sendOrgAdminSetupEmail(message));
    expect(result).toBe(false);
    expect(JSON.stringify(logged)).not.toContain('SENTINEL');
    expect(JSON.stringify(logged)).not.toContain('founder@tenant.example');
  });

  it('an accepted send logs nothing', async () => {
    send.mockResolvedValueOnce({ data: { id: 'msg_1' }, error: null });
    const { result, logged } = await capture(() => sendOrgAdminSetupEmail(message));
    expect(result).toBe(true);
    expect(logged).toEqual([]);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: 'founder@tenant.example',
        subject: 'Set up Acme & Co on Pravshi OS',
      }),
    );
  });
});
