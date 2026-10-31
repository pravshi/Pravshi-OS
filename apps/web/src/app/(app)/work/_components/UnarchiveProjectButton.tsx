'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { isErrorEnvelope, type Project, type WorkResult } from '../_types';

/**
 * UnarchiveProjectButton — restores an archived project (Phase 4).
 * Shown on the project detail page when the project is already archived.
 * On success the page refreshes so the header flips back to "Active".
 *
 * The onUnarchive prop is a bound server-action reference (never an inline
 * closure), per the P0-1 lesson about RSC serialization.
 */
export function UnarchiveProjectButton({
  onUnarchive,
}: {
  onUnarchive: () => Promise<WorkResult<Project>>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const result = await onUnarchive();
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        router.refresh();
      }
    } catch {
      setError('The unarchive request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
        {pending ? 'Unarchiving…' : 'Unarchive project'}
      </Button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
