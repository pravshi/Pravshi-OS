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
import { LinkButton } from '@/components/crm/link-button';
import { formatDateTime } from '@/components/crm/format';
import { JOB_PERMISSIONS, getJobPermissions } from './_permissions';
import { JOB_TYPE_LABELS, errorExcerpt, getJobsStats, listJobs, parseJobsFilter } from './_jobs';
import { JobStatusBadge } from './_components/JobStatusBadge';
import { JobFilterForm } from './_components/JobFilterForm';

function StatCard({ label, value, href }: { label: string; value: number; href?: string }) {
  const inner = (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{label}</p>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="transition-opacity hover:opacity-80">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function FilteredJobsLink({ label, href }: { label: string; href: string }) {
  return (
    <Link href={href} className="text-sm text-ink-muted hover:text-foreground">
      {label}
    </Link>
  );
}

/** /jobs — queue dashboard: stats, filters, job table. */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const auth = await requirePagePermission(JOB_PERMISSIONS.jobs.view);

  const params = await searchParams;
  const filter = parseJobsFilter(params);
  const filtered = filter.status !== undefined || filter.type !== undefined;

  let stats, jobs, held;
  try {
    [stats, jobs, held] = await Promise.all([
      getJobsStats(auth),
      listJobs(auth, filter),
      getJobPermissions(),
    ]);
  } catch {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load the job queue.' } }}
          title="Could not load jobs"
        />
      </div>
    );
  }

  const canCreate = held.has(JOB_PERMISSIONS.jobs.create);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-ink-muted">
            The durable queue behind automations — workflow runs, webhooks, emails, and cleanup,
            claimed and executed by workers.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/jobs/dead-letter" size="sm" variant="outline">
            Dead letter{stats.deadLetter > 0 ? ` (${stats.deadLetter})` : ''}
          </LinkButton>
          <LinkButton href="/jobs/schedules" size="sm" variant="outline">
            Schedules
          </LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Pending" value={stats.pending} href="/jobs?status=pending" />
        <StatCard label="Claimed & running" value={stats.running} href="/jobs?status=running" />
        <StatCard label="Failed (24h)" value={stats.failed24h} href="/jobs?status=failed" />
        <StatCard label="Dead letter" value={stats.deadLetter} href="/jobs/dead-letter" />
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Queue</CardTitle>
          <JobFilterForm initialStatus={filter.status ?? ''} initialType={filter.type ?? ''} />
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState
              title={filtered ? 'No jobs match your filters' : 'The queue is empty'}
              description={
                filtered
                  ? 'Try a different status or type.'
                  : 'Jobs appear here when workflows fire on schedules or events, or when notifications, emails, and webhooks are enqueued.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Link href={`/jobs/${job.id}`} className="hover:underline">
                          <JobStatusBadge status={job.status} />
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/jobs/${job.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {JOB_TYPE_LABELS[job.type]}
                        </Link>
                        {job.dedupKey && (
                          <p className="mt-0.5 font-mono text-[11px] text-ink-muted">
                            {job.dedupKey.length > 28
                              ? job.dedupKey.slice(0, 28) + '…'
                              : job.dedupKey}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {job.attempts}/{job.maxAttempts}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatDateTime(job.nextRunAt)}
                      </TableCell>
                      <TableCell
                        className="max-w-xs truncate text-sm text-ink-muted"
                        title={job.errorMessage ?? undefined}
                      >
                        {errorExcerpt(job)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-ink-muted">
                        {formatDateTime(job.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-4">
        <FilteredJobsLink label="All jobs →" href="/jobs" />
        {canCreate && (
          <FilteredJobsLink label="Schedules are created from workflows →" href="/jobs/schedules" />
        )}
      </div>
    </div>
  );
}
