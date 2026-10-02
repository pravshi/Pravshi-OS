import type { Deal } from '@/components/crm/types';

/**
 * A deal as the kanban board consumes it.
 *
 * The deals list API exposes pipelineId / pipelineStageId (nullable), so the
 * board groups by pipelineStageId when present and parks everything else in
 * the "Unassigned" column.
 */
export type BoardDeal = Deal;
