'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isErrorEnvelope, type DeleteResult, type WorkResult } from '../_types';

/**
 * ArchiveProjectDialog — confirm-then-archive for a project (Phase 4).
 *
 * Projects are never hard-deleted: archiving removes the project from the
 * active list while keeping its tasks, members and history intact, and an
 * archived project can be unarchived at any time. This replaces the generic
 * DeleteDialog on the project detail page, whose "Delete" copy was wrong for
 * the archive action it actually runs.
 *
 * The onArchive prop is a bound server-action reference (never an inline
 * closure), per the P0-1 lesson about RSC serialization.
 */
export function ArchiveProjectDialog({
  recordName,
  onArchive,
  disabled,
}: {
  recordName: string;
  onArchive: () => Promise<WorkResult<DeleteResult>>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const result = await onArchive();
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        setOpen(false);
        window.location.assign('/work');
      }
    } catch {
      setError('The archive request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Archive project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive project?</DialogTitle>
            <DialogDescription>
              “{recordName}” will be archived: it disappears from the active project list, but
              nothing is deleted — its tasks, members and history are kept and the project can be
              unarchived later.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={pending}>
              {pending ? 'Archiving…' : 'Archive project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
