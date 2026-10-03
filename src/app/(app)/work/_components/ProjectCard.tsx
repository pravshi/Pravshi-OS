import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { projectStatusBadgeClass, projectStatusLabel, type Project } from '../_types';

/** A project tile on the work home page. Server-rendered link card. */
export function ProjectCard({ project }: { project: Project }) {
  const openCount = (project.taskCounts?.todo ?? 0) + (project.taskCounts?.in_progress ?? 0);

  return (
    <Link
      href={`/work/projects/${project.id}`}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      aria-label={`Open project ${project.name}`}
    >
      <Card className="h-full transition-colors hover:border-neutral-400 dark:hover:border-neutral-500">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-semibold leading-snug tracking-tight">{project.name}</h2>
            <Badge className={projectStatusBadgeClass(project.isArchived)} variant="secondary">
              {projectStatusLabel(project.isArchived)}
            </Badge>
          </div>
          {project.description && (
            <p className="line-clamp-2 text-sm text-ink-muted">{project.description}</p>
          )}
          <p className="text-xs text-ink-muted">
            {openCount === 0
              ? 'No open tasks'
              : `${openCount} open ${openCount === 1 ? 'task' : 'tasks'}`}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
