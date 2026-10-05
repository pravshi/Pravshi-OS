'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/crm/empty-state';
import { formatDateTime } from '@/components/crm/format';
import { listWorkflowExecutionsAction } from '../_detail-actions';
import { isErrorEnvelope, toRows } from '../_types';
import { ExecutionStatusBadge } from './WorkflowStatusBadge';
import { ExecutionDetail } from './ExecutionDetail';
import { errorExcerpt, formatDurationMs } from './execution-format';
import type { ExecutionPage, WorkflowExecution } from '@/lib/workflows/service';

const PAGE_SIZE = 10;

/**
 * ExecutionList — run history table for one workflow.
 *
 * Columns: time, trigger, status badge, duration, error excerpt. Clicking a
 * row opens the per-step detail dialog. Pagination goes through the
 * listWorkflowExecutionsAction server action ({ rows, total, limit, offset }).
 */
export function ExecutionList({
  workflowId,
  initial,
}: {
  workflowId: string;
  initial: ExecutionPage;
}) {
  const [page, setPage] = useState<ExecutionPage>(initial);
  const [offset, setOffset] = useState(initial.offset ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkflowExecution | null>(null);

  const rows = toRows(page);
  const total = page.total ?? rows.length;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  async function goTo(nextOffset: number) {
    setLoading(true);
    setError(null);
    const res = await listWorkflowExecutionsAction(workflowId, {
      limit: PAGE_SIZE,
      offset: nextOffset,
    });
    setLoading(false);
    if (isErrorEnvelope(res)) {
      setError(res.error.message);
      return;
    }
    setPage(res);
    setOffset(nextOffset);
  }

  if (total === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="This workflow has not executed. Automatic runs appear here after the trigger fires; you can also run it manually."
      />
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((run) => (
              <TableRow
                key={run.id}
                className="cursor-pointer focus-visible:bg-muted/70 focus-visible:outline-none"
                onClick={() => setSelected(run)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(run);
                  }
                }}
              >
                <TableCell className="whitespace-nowrap">{formatDateTime(run.startedAt)}</TableCell>
                <TableCell className="font-mono text-xs">{run.triggerType}</TableCell>
                <TableCell>
                  <ExecutionStatusBadge status={run.status} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatDurationMs(run.durationMs)}
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-ink-muted">
                  {errorExcerpt(
                    run.errorCode ? `${run.errorCode}: ${run.errorMessage ?? ''}` : null,
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-ink-muted">
        <span>
          Showing {from}–{to} of {total}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || offset === 0}
            onClick={() => goTo(offset - PAGE_SIZE)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || to >= total}
            onClick={() => goTo(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Run detail</DialogTitle>
          </DialogHeader>
          {selected && <ExecutionDetail executionId={selected.id} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
