'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { JobStatus } from '../_jobs';

/**
 * JobActions — retry / cancel mutations for a job.
 *
 * Calls the REST endpoints (contract §4.1) directly so 400 (illegal state),
 * 403/404 (access changed), and 200 drive distinct toasts — the same reason
 * the Phase 5 RunNowButton hits the API instead of a server action.
 *
 * The parent server component decides which buttons render: canRetry only
 * when the user holds jobs.retry, canCancel only when they hold jobs.cancel.
 * These buttons are also state-aware — retry only for failed/dead_letter,
 * cancel only for pending/claimed/running.
 */
export function JobActions({
  jobId,
  status,
  canRetry,
  canCancel,
  cancelLabel = 'Cancel',
  size = 'sm',
}: {
  jobId: string;
  status: JobStatus;
  /** User holds jobs.retry — server-decided, never client-decided. */
  canRetry: boolean;
  /** User holds jobs.cancel — server-decided, never client-decided. */
  canCancel: boolean;
  /** Dead-letter pages call cancel "Discard" — same transition, different word. */
  cancelLabel?: string;
  size?: 'sm' | 'default';
}) {
  const router = useRouter();
  const [pending, setPending] = useState<'retry' | 'cancel' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const retryable = status === 'failed' || status === 'dead_letter';
  const cancellable = status === 'pending' || status === 'claimed' || status === 'running';

  if ((!canRetry || !retryable) && (!canCancel || !cancellable)) return null;

  async function post(path: string): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const res = await fetch(path, { method: 'POST' });
      let error: string | undefined;
      try {
        const body = await res.json();
        error = typeof body?.error === 'string' ? body.error : undefined;
      } catch {
        /* non-JSON body */
      }
      return { ok: res.ok, status: res.status, error };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async function doRetry() {
    setPending('retry');
    try {
      const outcome = await post(`/api/jobs/${encodeURIComponent(jobId)}/retry`);
      if (!outcome.ok) {
        if (outcome.status === 400)
          toast.error(outcome.error ?? 'This job can no longer be retried.');
        else if (outcome.status === 403 || outcome.status === 404)
          toast.error('Access changed — you can no longer retry this job.');
        else toast.error(outcome.error ?? 'The retry request failed.');
        return;
      }
      toast.success('Job re-queued.');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function doCancel() {
    setPending('cancel');
    try {
      const outcome = await post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`);
      if (!outcome.ok) {
        if (outcome.status === 400)
          toast.error(outcome.error ?? 'This job can no longer be cancelled.');
        else if (outcome.status === 403 || outcome.status === 404)
          toast.error(`Access changed — you can no longer ${cancelLabel.toLowerCase()} this job.`);
        else toast.error(outcome.error ?? 'The cancel request failed.');
        return;
      }
      toast.success(`Job ${cancelLabel === 'Discard' ? 'discarded' : 'cancelled'}.`);
      setConfirmCancel(false);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toaster />
      {canRetry && retryable && (
        <Button
          size={size}
          variant="outline"
          disabled={pending !== null}
          onClick={doRetry}
          title="Re-queue this job as pending"
        >
          {pending === 'retry' ? 'Retrying…' : 'Retry'}
        </Button>
      )}
      {canCancel && cancellable && (
        <>
          <Button
            size={size}
            variant={cancelLabel === 'Discard' ? 'destructive' : 'outline'}
            disabled={pending !== null}
            onClick={() => setConfirmCancel(true)}
          >
            {cancelLabel}
          </Button>
          <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {cancelLabel === 'Discard' ? 'Discard this job?' : 'Cancel this job?'}
                </DialogTitle>
                <DialogDescription>
                  {cancelLabel === 'Discard'
                    ? 'The job will be marked cancelled and removed from the dead-letter queue. It will not run again unless manually re-queued.'
                    : 'A pending or in-flight job will stop being claimed. A running job is asked to stop at its next heartbeat check.'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmCancel(false)} disabled={pending !== null}>
                  Keep job
                </Button>
                <Button variant="destructive" onClick={doCancel} disabled={pending !== null}>
                  {pending === 'cancel' ? `${cancelLabel === 'Discard' ? 'Discarding' : 'Cancelling'}…` : cancelLabel}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
