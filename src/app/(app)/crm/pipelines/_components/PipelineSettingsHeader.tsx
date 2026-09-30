'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Pipeline } from '@/components/crm/types';
import { PipelineDialog } from './PipelineForm';

/** Settings header: pipeline name/meta plus a perm-gated rename affordance. */
export function PipelineSettingsHeader({
  pipeline,
  canEdit,
}: {
  pipeline: Pipeline;
  canEdit: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{pipeline.name}</h1>
      {pipeline.isDefault && <Badge>Default</Badge>}
      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          Rename
        </Button>
      )}
      <PipelineDialog open={dialogOpen} onOpenChange={setDialogOpen} pipeline={pipeline} />
    </div>
  );
}
