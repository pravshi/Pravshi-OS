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
import { isErrorEnvelope, type CrmResult } from './types';

/**
 * Confirm-then-soft-delete. The action runs server-side and re-authorizes;
 * on success we navigate away because the record no longer lists.
 */
export function DeleteDialog({
  resourceName,
  recordName,
  onDelete,
  redirectTo,
  disabled,
}: {
  resourceName: string;
  recordName: string;
  onDelete: () => Promise<CrmResult<{ ok: boolean }>>;
  redirectTo: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const result = await onDelete();
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        setOpen(false);
        window.location.assign(redirectTo);
      }
    } catch {
      setError('The delete request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Delete {resourceName}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {resourceName}?</DialogTitle>
            <DialogDescription>
              “{recordName}” will be soft-deleted: it disappears from lists but stays in the audit
              trail and can be recovered by an administrator. This cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirm} disabled={pending}>
              {pending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
