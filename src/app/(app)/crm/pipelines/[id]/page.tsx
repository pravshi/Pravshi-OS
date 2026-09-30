import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/crm/error-message';
import { LinkButton } from '@/components/crm/link-button';
import { isErrorEnvelope } from '@/components/crm/types';
import {
  getPipelineAction,
  listPipelinesAction,
  getForecastAction,
  getVelocityAction,
  listBoardDealsAction,
} from '../_actions';
import {
  canManagePipelineStages,
  getCrmPermissions,
  requireCrmPagePermission,
} from '../../_permissions';
import { PipelineSwitcher } from '../_components/PipelineSwitcher';
import { PipelineKanban } from '../_components/PipelineKanban';
import { ForecastBar } from '../_components/ForecastBar';
import type { BoardDeal } from '../_components/board-types';

/**
 * /crm/pipelines/[id] — the kanban board. pipelines.view to see; deal moves
 * additionally require deals.edit (enforced by the API on drop).
 */
export default async function PipelineBoardPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrmPagePermission('pipelines', 'view');
  const { id } = await params;

  const [pipelineRes, pipelinesRes, forecastRes, velocityRes, dealsRes, held] =
    await Promise.all([
      getPipelineAction(id),
      listPipelinesAction({ limit: 100, offset: 0 }),
      getForecastAction(id),
      getVelocityAction(id),
      listBoardDealsAction(),
      getCrmPermissions(),
    ]);

  if (isErrorEnvelope(pipelineRes)) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorMessage error={pipelineRes} title="Could not load pipeline" />
      </div>
    );
  }

  const pipeline = pipelineRes;
  const pipelines = isErrorEnvelope(pipelinesRes) ? [] : pipelinesRes.rows;
  const forecast = isErrorEnvelope(forecastRes) ? null : forecastRes;
  const velocity = isErrorEnvelope(velocityRes) ? null : velocityRes;
  const dealsUnavailable = isErrorEnvelope(dealsRes);
  const deals: BoardDeal[] = dealsUnavailable ? [] : dealsRes.rows;
  const canMove = held.has('deals.edit');
  const canManageStages = canManagePipelineStages(held);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BackLink />
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{pipeline.name}</h1>
            {pipeline.isDefault && <Badge>Default</Badge>}
          </div>
          {pipeline.description && (
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">{pipeline.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <PipelineSwitcher pipelines={pipelines} currentId={pipeline.id} />
          {canManageStages && (
            <LinkButton href={`/crm/pipelines/${pipeline.id}/settings`} variant="outline" size="sm">
              Manage stages
            </LinkButton>
          )}
        </div>
      </div>

      <ForecastBar forecast={forecast} stages={pipeline.stages} />

      <PipelineKanban
        key={pipeline.id}
        pipeline={pipeline}
        initialDeals={deals}
        velocity={velocity}
        canMove={canMove}
        dealsUnavailable={dealsUnavailable}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/crm/pipelines" className="text-sm text-ink-muted hover:text-foreground">
      ← All pipelines
    </Link>
  );
}
