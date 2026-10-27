'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/client';

export function SignOutButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await authClient.signOut();
        window.location.assign('/login?next=%2Fplatform');
      }}
    >
      Sign out
    </Button>
  );
}
