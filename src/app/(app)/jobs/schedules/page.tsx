import Link from 'next/link';
import { headers } from 'next/headers';
import { requirePagePermission } from '@/lib/authz/page';
import { requirePermission } from '@/lib/authz/require-permission';
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
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/components/crm/format';
import { listWorkflows } from '@/lib/workflows/service';
import { JOB_PERMISSIONS, getJobPermissions } from '../_permissions';
import { listSchedules } from '../_jobs';
import { ScheduleForm } from '../_components/ScheduleForm';
import { ScheduleRowActions } from '../_components/ScheduleRowActions';

/** /jobs/schedules — schedule list + create/edit form. */
export default async function SchedulesPage() {
  const auth = await requirePagePermission(JOB_PERMISSIONS.jobs.view);

  let schedules, held;
  try {
    [schedules, held] = await Promise.all([listSchedules(auth), getJobPermissions()]);
  } catch {
    return (
      <div className="space-y-6">
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
          ← All jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
        <ErrorMessage
          error={{
            error: { code: 'INTERNAL', message: 'Could not load schedules.' },
          }}
          title="Could not load schedules"
        />
      </div>
    );
  }

  const canCreate = held.has(JOB_PERMISSIONS.jobs.create);
  const canDelete = held.has(JOB_PERMISSIONS.jobs.delete);

  // Workflow picker options for the create/edit form. A user who can schedule
  // but cannot view workflows gets a free-text id input instead of a hard
  // failure — never block schedule creation on an unrelated permission.
  let workflowOptions: { id: string; name: string }[] = [];
  try {
    const wfAuth = await requirePermission(await headers(), { permission: 'workflows.view' });
    const page = await listWorkflows(wfAuth, { limit: 100, offset: 0 });
    workflowOptions = page.rows.map((w) => ({ id: w.id, name: w.name }));
  } catch {
    workflowOptions = [];
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/jobs" className="text-sm text-ink-muted hover:text-foreground">
          ← All jobs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Schedules</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Cron schedules that enqueue workflow runs. The scheduler ticks every minute, enqueuing
          each due schedule exactly once per window.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Schedules
            <span className="ml-2 text-sm font-normal text-ink-muted">({schedules.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <EmptyState
              title="No schedules yet"
              description={
                canCreate
                  ? 'Create one below — e.g. run your pipeline-review workflow every weekday at 9.'
                  : 'No schedules are set up yet.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Cron</TableHead>
                    <TableHead>Timezone</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell>
                        <Link
                          href={`/workflows/${s.workflowId}`}
                          className="text-sm hover:underline"
                        >
                          {s.workflowName ?? 'View workflow'}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{s.cron}</TableCell>
                      <TableCell className="text-sm text-ink-muted">{s.timezone}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            s.isActive
                              ? 'border-green-200 text-green-700 dark:border-green-900 dark:text-green-300'
                              : 'text-ink-muted'
                          }
                        >
                          {s.isActive ? 'Active' : 'Paused'}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-ink-muted">
                        {s.nextRunAt ? formatDateTime(s.nextRunAt) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <ScheduleRowActions
                          schedule={s}
                          workflows={workflowOptions}
                          canEdit={canCreate}
                          canDelete={canDelete}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>New schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-2xl">
              <ScheduleForm workflows={workflowOptions} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
