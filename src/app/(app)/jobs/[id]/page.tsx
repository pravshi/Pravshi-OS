import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePagePermission } from '@/lib/authz/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import { DetailField } from '@/components/crm/detail-fields';
import { formatDateTime } from '@/components/crm/format';
import { JOB_PERMISSIONS, getJobPermissions } from '../_permissions';
import {
  JOB_TYPE_LABELS,
  getJob,
  sanitizedPayloadJson,
  type JobRow,
} from '../_jobs';
import { JobStatusBadge } from '../_components/JobStatusBadge';
import { JobActions } from '../_components/JobActions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function JobTimeline({ job }: { job: JobRow }) {
  const events: { at: string; label: string }[] = [
    { at: job.createdAt, label: 'Enqueued' },
    ...(job.claimedAt ? [{ at: job.claimedAt, label: `Claimed${job.claimedBy ? ` by ${job.claimedBy}` : ''}` }] : []),
    ...(job.heartbeatAt ? [{ at: job.heartbeatAt, label: 'Last worker heartbeat' }] : []),
    ...(job.status === 'pending' ? [{ at: job.nextRunAt, label: 'Next run (due)' }] : []),
    ...(job.status === 'failed' || job.status === 'dead_letter'
      ? [{ at: job.updatedAt, label: 'Attempt recorded' }]
      : []),
  ];
  return (
    <ol className="space-y-2 text-sm">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-baseline gap-3">
          <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-foreground/40" />
          <span className="min-w-0">
            <span className="font-medium">{e.label}</span>
            <span className="ml-2 text-ink-muted">{formatDateTime(e.at)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** /jobs/[id] — job detail: sanitized payload, attempts, error, timeline, retry/cancel. */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePagePermission(JOB_PERMISSIONS.jobs.view);
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [job, held] = await Promise.all([getJob(auth, id), getJobPermissions()]);

  if (!job) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
          ← All jobs
        </Link>
        <ErrorMessage
          error={{
            error: { code: 'NOT_FOUND', message: 'This job does not exist or is not visible to you.' },
          }}
          title="Job not found"
        />
      </div>
    );
  }

  const canRetry = held.has(JOB_PERMISSIONS.jobs.retry);
  const canCancel = held.has(JOB_PERMISSIONS.jobs.cancel);
  const workflowId = job.type === 'workflow_run' && typeof job.payload.workflowId === 'string'
    ? (job.payload.workflowId as string)
    : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
            ← All jobs
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{JOB_TYPE_LABELS[job.type]}</h1>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-ink-muted">{job.id}</p>
        </div>
        <JobActions jobId={job.id} status={job.status} canRetry={canRetry} canCancel={canCancel} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Attempts & scheduling</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 sm:grid-cols-2">
            <DetailField label="Attempts">
              <span className="tabular-nums">
                {job.attempts} of {job.maxAttempts}
              </span>
            </DetailField>
            <DetailField label="Next run">{formatDateTime(job.nextRunAt)}</DetailField>
            <DetailField label="Priority">{job.priority}</DetailField>
            <DetailField label="Dedup key">
              {job.dedupKey ? <span className="font-mono text-xs">{job.dedupKey}</span> : '—'}
            </DetailField>
            {job.claimedBy && (
              <DetailField label="Claimed by">
                <span className="font-mono text-xs">{job.claimedBy}</span>
                {job.claimedAt ? ` · ${formatDateTime(job.claimedAt)}` : ''}
              </DetailField>
            )}
            {workflowId && UUID.test(workflowId) && (
              <DetailField label="Workflow">
                <Link href={`/workflows/${workflowId}`} className="hover:underline">
                  View workflow →
                </Link>
              </DetailField>
            )}
          </dl>
        </CardContent>
      </Card>

      {(job.errorCode || job.errorMessage) && (
        <Card>
          <CardHeader>
            <CardTitle>Last error</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {job.errorCode && (
              <p className="font-mono text-xs text-ink-muted">{job.errorCode}</p>
            )}
            {job.errorMessage && (
              <p className="whitespace-pre-wrap text-sm">{job.errorMessage}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Payload</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-ink-muted">
            Secrets and credentials are redacted before display.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-4 font-mono text-xs leading-relaxed dark:bg-gray-900/60">
            {sanitizedPayloadJson(job.payload)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTimeline job={job} />
        </CardContent>
      </Card>
    </div>
  );
}
