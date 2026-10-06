import { JOB_STATUS_LABELS, jobStatusBadgeClass, type JobStatus } from '../_jobs';

/** JobStatusBadge — colored pill for a job status, Phase 5 WorkflowStatusBadge pattern. */
export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${jobStatusBadgeClass(status)}`}
    >
      {JOB_STATUS_LABELS[status]}
    </span>
  );
}
