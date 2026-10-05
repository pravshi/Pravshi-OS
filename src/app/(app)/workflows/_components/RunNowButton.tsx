'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { executeWorkflowViaApi } from '../_test-run';
import { ExecutionDetail } from './ExecutionDetail';

/**
 * RunNowButton — manual "Run now" for a workflow definition.
 *
 * Calls POST /api/workflows/[id]/execute directly (via the builder track's
 * executeWorkflowViaApi) so the 202 / 400 / 403+ statuses drive distinct
 * toasts. Only ACTIVE workflows execute — a DRAFT or PAUSED workflow answers
 * 400 INVALID_REQUEST. On success the returned executionId is shown with a
 * "View run" button that opens the per-step detail dialog.
 */
export function RunNowButton({
  workflowId,
  status,
}: {
  workflowId: string;
  /** Definition status — the button is disabled unless ACTIVE. */
  status: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function runNow() {
    setPending(true);
    try {
      const outcome = await executeWorkflowViaApi(workflowId);
      if (!outcome.ok) {
        if (outcome.status === 400)
          toast.error(outcome.error ?? 'This workflow cannot run right now.');
        else if (outcome.status === 403 || outcome.status === 404)
          toast.error('Access changed — you can no longer run this workflow.');
        else toast.error(outcome.error ?? 'The run request failed.');
        return;
      }
      setLastRunId(outcome.executionId);
      toast.success('Run started.');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toaster />
      <Button
        size="sm"
        variant="outline"
        disabled={pending || status !== 'ACTIVE'}
        onClick={runNow}
        title={status !== 'ACTIVE' ? 'Only active workflows can run' : 'Run this workflow now'}
      >
        {pending ? 'Running…' : 'Run now'}
      </Button>
      {lastRunId && (
        <Button size="sm" variant="ghost" onClick={() => setDialogOpen(true)}>
          View run details</Button>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Run detail</DialogTitle>
          </DialogHeader>
          {lastRunId && <ExecutionDetail executionId={lastRunId} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
