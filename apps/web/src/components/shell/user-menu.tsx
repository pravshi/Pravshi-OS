'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleUserRound, LogOut, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient, signOut } from '@/lib/auth/client';

/**
 * The shell's user menu — account identity and sign-out (AUD-03).
 *
 * Until now the application had NO sign-out control: signOut existed in the
 * auth client imported nowhere, and the only way out was revoking the session
 * row from /me/security — a different library path that never crosses the
 * /sign-out endpoint, so the Phase 11 SESSION_REVOKED recording (which keys
 * off that endpoint) never fired for it.
 *
 * This menu signs out through the library client, whose POST to
 * /api/auth/sign-out deletes the session through the endpoint the recording
 * hook watches. After sign-out the user lands on /login; if the session
 * somehow survived, the login page's own signed-in redirect sends them back
 * into the app rather than leaving a stale form on screen.
 */
export function UserMenu() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // The navigation below is the recovery either way — see the note above.
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Account">
            <CircleUserRound className="h-4 w-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {session?.user?.email && (
          <>
            <DropdownMenuLabel className="max-w-56 truncate font-normal text-ink-muted">
              {session.user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => router.push('/me/security')}>
          <ShieldCheck className="mr-2 h-4 w-4" aria-hidden />
          My security
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSignOut} disabled={signingOut}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
