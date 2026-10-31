import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/crm/empty-state';
import { ErrorMessage } from '@/components/crm/error-message';
import { formatDateTime } from '@/components/crm/format';
import { JOB_PERMISSIONS, getJobPermissions } from '../_permissions';
import { JOB_TYPE_LABELS, errorExcerpt, listDeadLetterJobs } from '../_jobs';
import { JobActions } from '../_components/JobActions';

/**
 * /jobs/dead-letter — review jobs that exhausted retries or failed
 * non-retryably. Per-row actions: Retry (re-queue) or Discard (cancel),
 * each gated by the held permission set.
 */
export default async function DeadLetterPage() {
  const auth = await requirePagePermission(JOB_PERMISSIONS.jobs.view);

  let jobs, held;
  try {
    [jobs, held] = await Promise.all([listDeadLetterJobs(auth), getJobPermissions()]);
  } catch {
    return (
      <div className="space-y-6">
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
          ← All jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Dead letter</h1>
        <ErrorMessage
          error={{
            error: { code: 'INTERNAL', message: 'Could not load the dead-letter queue.' },
          }}
          title="Could not load dead letter"
        />
      </div>
    );
  }

  const canRetry = held.has(JOB_PERMISSIONS.jobs.retry);
  const canCancel = held.has(JOB_PERMISSIONS.jobs.cancel);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
          ← All jobs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Dead letter</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Jobs that exhausted their retries or failed non-retryably. Fix the cause, then retry — or
          discard the ones you no longer need.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Dead-letter queue
            <span className="ml-2 text-sm font-normal text-ink-muted">({jobs.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState
              title="No dead-letter jobs"
              description="Every job is either succeeding, retrying, or still in flight. When a job exhausts its attempts, it lands here for review."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Failed at</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Link
                          href={`/jobs/${job.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {JOB_TYPE_LABELS[job.type]}
                        </Link>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          {job.id.slice(0, 8)}…
                        </p>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {job.attempts}/{job.maxAttempts}
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {job.errorCode && (
                          <p className="font-mono text-[11px] text-ink-muted">{job.errorCode}</p>
                        )}
                        <p className="truncate text-sm" title={job.errorMessage ?? undefined}>
                          {errorExcerpt(job)}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-ink-muted">
                        {formatDateTime(job.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end">
                          <JobActions
                            jobId={job.id}
                            status={job.status}
                            canRetry={canRetry}
                            canCancel={canCancel}
                            cancelLabel="Discard"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
