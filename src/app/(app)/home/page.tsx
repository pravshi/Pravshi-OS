import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { ArrowRight } from 'lucide-react';
import { requireAuthenticated } from '@/lib/authz/page';
import { heldNavPermissions } from '@/lib/authz/nav';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * /home — the signed-in landing page.
 *
 * Login lands users on `/`, which redirects here. The page is deliberately
 * permission-aware: module cards render only for permissions the viewer
 * holds (the same authz.has() rendering pattern the sidebar uses — UI
 * filtering, not an authorization decision; every target page still
 * authorizes for itself). Counts are best-effort summaries under RLS and
 * are omitted entirely when their permission is not held.
 */

interface ModuleCard {
  label: string;
  href: string;
  permission: string;
  description: string;
}

const MODULES: ModuleCard[] = [
  {
    label: 'Analytics overview',
    href: '/analytics',
    permission: 'reports.view',
    description: 'Revenue, pipeline, and team performance at a glance.',
  },
  {
    label: 'Companies',
    href: '/crm/companies',
    permission: 'companies.view',
    description: 'Every account your team works with.',
  },
  {
    label: 'Contacts',
    href: '/crm/contacts',
    permission: 'contacts.view',
    description: 'People at those companies, and how to reach them.',
  },
  {
    label: 'Deals',
    href: '/crm/deals',
    permission: 'deals.view',
    description: 'Open opportunities and where they stand.',
  },
  {
    label: 'Pipelines',
    href: '/crm/pipelines',
    permission: 'pipelines.view',
    description: 'Stages and flow for every sales pipeline.',
  },
  {
    label: 'Activities',
    href: '/crm/activities',
    permission: 'activities.view',
    description: 'Calls, meetings, and follow-ups across the CRM.',
  },
  {
    label: 'Work',
    href: '/work',
    permission: 'projects.view',
    description: 'Projects and the work planned inside them.',
  },
  {
    label: 'Workflows',
    href: '/workflows',
    permission: 'workflows.view',
    description: 'Automations that run your processes.',
  },
  {
    label: 'Jobs',
    href: '/jobs',
    permission: 'jobs.view',
    description: 'Background job queues and their health.',
  },
];

async function firstName(ctx: { personId: string; orgId: string; aal: 'aal1' | 'aal2' }) {
  try {
    return await withAuthorizedDb(ctx, async (tx) => {
      const res = await tx.execute<{ name: string | null }>(sql`
        select coalesce(preferred_name, split_part(full_legal_name, ' ', 1)) as name
        from public.people
        where id = ${ctx.personId}
        limit 1
      `);
      return res.rows[0]?.name ?? null;
    });
  } catch {
    return null;
  }
}

async function summaryCounts(
  ctx: { personId: string; orgId: string; aal: 'aal1' | 'aal2' },
  held: Set<string>,
): Promise<{ unread: number | null; openTasks: number | null }> {
  let unread: number | null = null;
  let openTasks: number | null = null;
  try {
    await withAuthorizedDb(ctx, async (tx) => {
      if (held.has('notifications.view')) {
        const res = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n
          from public.notifications
          where person_id = ${ctx.personId} and read_at is null
        `);
        unread = res.rows[0]?.n ?? 0;
      }
      if (held.has('tasks.view')) {
        const res = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n
          from public.work_tasks
          where assignee_person_id = ${ctx.personId}
            and status in ('todo', 'in_progress')
            and deleted_at is null
        `);
        openTasks = res.rows[0]?.n ?? 0;
      }
    });
  } catch {
    // Summaries are decorative; a failed count must never break Home.
    unread = null;
    openTasks = null;
  }
  return { unread, openTasks };
}

export default async function HomePage() {
  const ctx = await requireAuthenticated();
  const held = await heldNavPermissions();
  const [name, counts] = await Promise.all([firstName(ctx), summaryCounts(ctx, held)]);
  const modules = MODULES.filter((m) => held.has(m.permission));

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        title={name ? `Welcome back, ${name}` : 'Welcome back'}
        description="Your workspace — pick up where you left off."
      />

      {(counts.openTasks !== null || counts.unread !== null) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {counts.openTasks !== null && (
            <Link href="/work/my-tasks" className="group block">
              <Card className="transition-colors group-hover:border-foreground/20">
                <CardHeader className="pb-2">
                  <CardDescription>My open tasks</CardDescription>
                  <CardTitle className="text-3xl font-semibold tabular-nums">
                    {counts.openTasks}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-1 text-sm text-muted-foreground">
                  View my tasks
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </CardContent>
              </Card>
            </Link>
          )}
          {counts.unread !== null && (
            <Link href="/notifications" className="group block">
              <Card className="transition-colors group-hover:border-foreground/20">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-2">
                    Unread notifications
                    {counts.unread > 0 && <Badge variant="secondary">{counts.unread} new</Badge>}
                  </CardDescription>
                  <CardTitle className="text-3xl font-semibold tabular-nums">
                    {counts.unread}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-1 text-sm text-muted-foreground">
                  Open notification center
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </CardContent>
              </Card>
            </Link>
          )}
        </div>
      )}

      {modules.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => (
            <Link key={m.href} href={m.href} className="group block">
              <Card className="h-full transition-colors group-hover:border-foreground/20">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    {m.label}
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </CardTitle>
                  <CardDescription>{m.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No modules assigned yet</CardTitle>
            <CardDescription>
              Your account does not have access to any modules yet. Ask an administrator to grant
              you a role.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
