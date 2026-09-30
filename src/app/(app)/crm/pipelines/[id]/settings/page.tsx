import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { ErrorMessage } from '@/components/crm/error-message';
import { isErrorEnvelope } from '@/components/crm/types';
import { getPipelineAction } from '../../_actions';
import {
  PIPELINE_STAGES_MANAGE,
  getCrmPermissions,
  requireCrmPagePermission,
  uiPermissionsFor,
} from '../../../_permissions';
import { StageRowEditor, AddStageForm } from '../../_components/StageForm';
import { PipelineSettingsHeader } from '../../_components/PipelineSettingsHeader';

/**
 * /crm/pipelines/[id]/settings — stage configuration.
 * pipelines.view to see the pipeline, pipeline_stages.manage to change stages.
 */
export default async function PipelineSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCrmPagePermission('pipelines', 'view');
  await requirePagePermission(PIPELINE_STAGES_MANAGE);
  const { id } = await params;

  const [pipelineRes, held] = await Promise.all([getPipelineAction(id), getCrmPermissions()]);

  if (isErrorEnvelope(pipelineRes)) {
    return (
      <div className="space-y-6">
        <BackLink pipelineId={id} />
        <ErrorMessage error={pipelineRes} title="Could not load pipeline" />
      </div>
    );
  }

  const pipeline = pipelineRes;
  const perms = uiPermissionsFor(held, 'pipelines');
  const stages = [...pipeline.stages].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
  );

  return (
    <div className="space-y-6">
      <div>
        <BackLink pipelineId={pipeline.id} />
        <div className="mt-2">
          <PipelineSettingsHeader pipeline={pipeline} canEdit={perms.canEdit} />
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold">Stages</h2>
          <p className="text-sm text-ink-muted">{stages.length} stages in position order</p>
        </div>
        {stages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-muted">
            No stages yet — add the first one below.
          </p>
        ) : (
          stages.map((stage, i) => (
            <StageRowEditor
              key={stage.id}
              stage={stage}
              isFirst={i === 0}
              isLast={i === stages.length - 1}
            />
          ))
        )}
        <AddStageForm pipelineId={pipeline.id} />
        <p className="rounded-lg border border-line bg-ground px-4 py-3 text-sm text-ink-muted">
          Stages with history cannot be deleted — rename or repurpose them instead. Deleting a stage
          would orphan its deal history, so the API refuses it by design.
        </p>
      </section>
    </div>
  );
}

function BackLink({ pipelineId }: { pipelineId: string }) {
  return (
    <Link
      href={`/crm/pipelines/${pipelineId}`}
      className="text-sm text-ink-muted hover:text-foreground"
    >
      ← Back to board
    </Link>
  );
}
