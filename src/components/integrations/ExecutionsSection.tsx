'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/components/crm/format';
import { EmptyState } from '@/components/crm/empty-state';
import {
  executionKindLabel,
  executionStatusTone,
  IntegrationsApiError,
  type IntegrationExecutionPageWire,
  type IntegrationExecutionWire,
  type StatusTone,
} from './integrations-client';

/**
 * ExecutionsSection — the merged execution history (Phase 10, Wave G;
 * contract §4.4): outbound webhook deliveries and email sends (Phase 6
 * jobs) alongside inbound webhook receipts, newest first.
 *
 * Retry deliberately lives elsewhere: rows with a job link out to the
 * job detail surface (/jobs/[id]), where the existing retry action —
 * gated by jobs.retry — does the work. This section is a read model,
 * not a second queue UI.
 */

const TONE_VARIANT: Record<StatusTone, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  success: 'default',
  muted: 'secondary',
  warning: 'outline',
  danger: 'destructive',
};

type KindFilter = IntegrationExecutionWire['kind'] | 'all';

function detailFor(execution: IntegrationExecutionWire): string {
  if (execution.kind === 'webhook_delivery') {
    return execution.targetUrl ?? 'Webhook endpoint';
  }
  if (execution.kind === 'inbound_event') {
    return execution.eventKey ? `Event ${execution.eventKey}` : 'Inbound delivery';
  }
  return 'Email send';
}

export function ExecutionsSection({
  executions,
  onRefresh,
}: {
  executions: IntegrationExecutionPageWire;
  onRefresh: (kind?: IntegrationExecutionWire['kind']) => Promise<void>;
}) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [busy, setBusy] = useState(false);

  const refresh = async (nextKind: KindFilter) => {
    setBusy(true);
    try {
      await onRefresh(nextKind === 'all' ? undefined : nextKind);
    } catch (error) {
      toast.error(
        error instanceof IntegrationsApiError ? error.message : 'Could not refresh the history.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Execution history</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Every outbound delivery, email send and inbound receipt for this workspace. Retries are
          handled on the job itself.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">
            Recent activity
            <span className="ml-2 text-sm font-normal text-ink-muted">
              {executions.total} total
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by kind"
              value={kind}
              onChange={(e) => {
                const next = e.target.value as KindFilter;
                setKind(next);
                void refresh(next);
              }}
              className="h-8 rounded-lg border border-line bg-background px-2 text-sm"
            >
              <option value="all">All kinds</option>
              <option value="webhook_delivery">Webhook deliveries</option>
              <option value="email">Email</option>
              <option value="inbound_event">Inbound events</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void refresh(kind)}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {executions.rows.length === 0 ? (
            <EmptyState
              title="No executions yet"
              description="Deliveries, sends and inbound receipts will appear here as they happen."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.rows.map((execution) => (
                  <TableRow key={`${execution.kind}-${execution.id}`}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(execution.occurredAt)}
                    </TableCell>
                    <TableCell>{executionKindLabel(execution.kind)}</TableCell>
                    <TableCell>
                      <Badge variant={TONE_VARIANT[executionStatusTone(execution.status)]}>
                        {execution.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-56 truncate">{detailFor(execution)}</TableCell>
                    <TableCell className="font-mono text-xs">{execution.eventKey ?? '—'}</TableCell>
                    <TableCell>{execution.attempts ?? '—'}</TableCell>
                    <TableCell className="text-destructive">{execution.errorCode ?? ''}</TableCell>
                    <TableCell>
                      {execution.jobId && (
                        <Link
                          href={`/jobs/${execution.jobId}`}
                          className="text-sm text-primary underline-offset-4 hover:underline"
                        >
                          View job
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
