'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import type { ProjectLinkSummary } from '@/lib/work/schema';

/**
 * RelatedProjectSection — the "Related project" block for the deal detail
 * page.
 *
 * Shows the project linked to this deal (name, archived state) with a link
 * to the project, or a "not linked" state explaining that linking happens
 * from the project side. Pure display: it never writes.
 *
 * INTEGRATION POINT — add this to src/app/(app)/crm/deals/[id]/page.tsx
 * (see docs/deal-project-integration.md §4) without editing any other CRM
 * file:
 *   import { RelatedProjectSection } from '@/components/crm/related-project-section';
 *   const projectRes = await fetchProjectForDeal(deal.id); // server action
 *     // proxying GET /api/crm/deals/{id}/project, guarded by projects.view
 *   {<RelatedProjectSection initialProject={projectRes} />}
 * Place it after the "Details" card; gate it on the caller holding
 * 'projects.view' (the route already does; the page should mirror the gate
 * so the section hides rather than errors).
 */
export function RelatedProjectSection({
  initialProject = null,
}: {
  initialProject?: ProjectLinkSummary | null;
}) {
  const project = initialProject;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Related project</CardTitle>
      </CardHeader>
      <CardContent>
        {project ? (
          <dl className="divide-y divide-line">
            <DetailField label="Project">
              <DetailLink href={`/work/projects/${project.id}`}>{project.name}</DetailLink>
            </DetailField>
            <DetailField label="Status">
              {project.isArchived ? (
                <Badge variant="secondary">Archived</Badge>
              ) : (
                <span className="text-sm">Active</span>
              )}
            </DetailField>
            {project.description && (
              <DetailField label="About">
                <span className="text-sm">{project.description}</span>
              </DetailField>
            )}
          </dl>
        ) : (
          <p className="text-sm text-ink-muted">
            No project is linked to this deal yet. Projects are linked from the project detail page.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
