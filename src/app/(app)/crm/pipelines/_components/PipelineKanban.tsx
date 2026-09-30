'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/crm/empty-state';
import type {
  PipelineWithStages,
  Velocity,
  VelocityStageRow,
} from '@/components/crm/types';
import { StageColumn } from './StageColumn';
import { DealCard } from './DealCard';
import type { BoardDeal } from './board-types';

type ColumnsState = Record<string, BoardDeal[]>;

function groupDeals(
  deals: BoardDeal[],
  stageIds: Set<string>,
): { columns: ColumnsState; unassigned: BoardDeal[] } {
  const columns: ColumnsState = {};
  for (const id of stageIds) columns[id] = [];
  const unassigned: BoardDeal[] = [];
  for (const deal of deals) {
    if (deal.pipelineStageId && stageIds.has(deal.pipelineStageId)) {
      const bucket = columns[deal.pipelineStageId];
      if (bucket) bucket.push(deal);
      else unassigned.push(deal);
    } else {
      unassigned.push(deal);
    }
  }
  return { columns, unassigned };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pipeline board. Native HTML5 drag-and-drop (no DnD library):
 *
 *  - drop → optimistic move → POST /api/crm/deals/:id/move { stageId }
 *  - 400 (unknown / cross-pipeline stage) → toast "Cannot move there" + rollback
 *  - 403/404 (access lost mid-session) → toast + refetch from the server
 *  - network failure → toast + rollback
 */
export function PipelineKanban({
  pipeline,
  initialDeals,
  velocity,
  canMove,
  dealsUnavailable,
}: {
  pipeline: PipelineWithStages;
  initialDeals: BoardDeal[];
  velocity: Velocity | null;
  canMove: boolean;
  dealsUnavailable: boolean;
}) {
  const router = useRouter();
  const stages = pipeline.stages;
  const stageIds = useMemo(() => new Set(stages.map((s) => s.id)), [stages]);

  const initial = useMemo(
    () => groupDeals(initialDeals, stageIds),
    [initialDeals, stageIds],
  );
  const [columns, setColumns] = useState<ColumnsState>(initial.columns);
  const [unassigned, setUnassigned] = useState<BoardDeal[]>(initial.unassigned);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStageId, setOverStageId] = useState<string | null>(null);
  const [showVelocity, setShowVelocity] = useState(false);
  const snapshot = useRef<{ columns: ColumnsState; unassigned: BoardDeal[] } | null>(null);

  const velocityByStage = useMemo(() => {
    const map = new Map<string, VelocityStageRow>();
    for (const row of velocity?.stages ?? []) map.set(row.stageId, row);
    return map;
  }, [velocity]);

  /** The stage holding the deal, null when unassigned, undefined when unknown. */
  function findSource(dealId: string): string | null | undefined {
    for (const [stageId, deals] of Object.entries(columns)) {
      if (deals.some((d) => d.id === dealId)) return stageId;
    }
    if (unassigned.some((d) => d.id === dealId)) return null;
    return undefined;
  }

  function removeFrom(
    cols: ColumnsState,
    unas: BoardDeal[],
    dealId: string,
    source: string | null,
  ): { deal: BoardDeal | null; cols: ColumnsState; unas: BoardDeal[] } {
    if (source === null) {
      const deal = unas.find((d) => d.id === dealId) ?? null;
      return { deal, cols, unas: unas.filter((d) => d.id !== dealId) };
    }
    const deal = cols[source]?.find((d) => d.id === dealId) ?? null;
    return {
      deal,
      cols: { ...cols, [source]: (cols[source] ?? []).filter((d) => d.id !== dealId) },
      unas,
    };
  }

  async function moveDeal(dealId: string, toStageId: string) {
    if (!canMove || !UUID_RE.test(dealId) || !UUID_RE.test(toStageId)) return;
    const source = findSource(dealId);
    if (source === undefined || source === toStageId) return;

    snapshot.current = { columns, unassigned };
    const { deal, cols, unas } = removeFrom(columns, unassigned, dealId, source);
    if (!deal) return;
    const moved: BoardDeal = { ...deal, pipelineStageId: toStageId };
    setColumns({ ...cols, [toStageId]: [...(cols[toStageId] ?? []), moved] });
    setUnassigned(unas);
    setOverStageId(null);
    setDraggingId(null);

    try {
      const res = await fetch(`/api/crm/deals/${dealId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId: toStageId }),
      });
      if (res.ok) {
        const data: { toStageId?: string } = await res.json().catch(() => ({}));
        // Reconcile against the authoritative answer, not our guess.
        if (data.toStageId && data.toStageId !== toStageId && stageIds.has(data.toStageId)) {
          setColumns((prev) => {
            const next: ColumnsState = { ...prev };
            next[toStageId] = (next[toStageId] ?? []).filter((d) => d.id !== dealId);
            next[data.toStageId as string] = [
              ...(next[data.toStageId as string] ?? []),
              { ...moved, pipelineStageId: data.toStageId ?? null },
            ];
            return next;
          });
        }
        return;
      }
      const snap = snapshot.current;
      if (res.status === 400) {
        if (snap) {
          setColumns(snap.columns);
          setUnassigned(snap.unassigned);
        }
        toast.error('Cannot move there', {
          description: 'That stage is not part of this pipeline.',
        });
      } else if (res.status === 403 || res.status === 404) {
        toast.error('Move failed', {
          description: 'Your access changed — reloading the board.',
        });
        router.refresh();
      } else {
        if (snap) {
          setColumns(snap.columns);
          setUnassigned(snap.unassigned);
        }
        toast.error('Move failed', { description: 'Please try again.' });
      }
    } catch {
      const snap = snapshot.current;
      if (snap) {
        setColumns(snap.columns);
        setUnassigned(snap.unassigned);
      }
      toast.error('Move failed', { description: 'Check your connection and try again.' });
    }
  }

  if (stages.length === 0) {
    return (
      <>
        <Toaster />
        <EmptyState
          title="This pipeline has no stages yet"
          description="Add stages in pipeline settings before deals can be placed on the board."
        />
      </>
    );
  }

  return (
    <>
      <Toaster />
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-muted">
          {canMove
            ? 'Drag a card onto another column to move the deal.'
            : 'You can view this board but not move deals.'}
        </p>
        {velocity && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowVelocity((v) => !v)}
            aria-pressed={showVelocity}
          >
            {showVelocity ? 'Hide velocity' : 'Show velocity'}
          </Button>
        )}
      </div>

      {dealsUnavailable && (
        <p className="rounded-lg border border-line bg-ground px-4 py-3 text-sm text-ink-muted">
          Deal cards are hidden because you don&apos;t hold <code>deals.view</code>. Stage
          counts and the forecast above still reflect the full pipeline.
        </p>
      )}

      {unassigned.length > 0 && (
        <section aria-label="Unassigned deals" className="rounded-lg border border-dashed border-line p-3">
          <p className="mb-2 text-sm text-ink-muted">
            {unassigned.length} visible {unassigned.length === 1 ? 'deal is' : 'deals are'} not
            placed on any stage — the deals API does not expose stage membership yet. Drag{' '}
            {unassigned.length === 1 ? 'it' : 'them'} onto a column to place{' '}
            {unassigned.length === 1 ? 'it' : 'them'}.
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((deal) => (
              <div key={deal.id} className="w-64">
                <DealCard
                  deal={deal}
                  draggable={canMove}
                  onDragStart={setDraggingId}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setOverStageId(null);
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex gap-4 overflow-x-auto pb-4" role="list" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <div key={stage.id} role="listitem" className="shrink-0">
            <StageColumn
              stage={stage}
              deals={columns[stage.id] ?? []}
              velocity={velocityByStage.get(stage.id) ?? null}
              showVelocity={showVelocity}
              canMove={canMove}
              isDragOver={overStageId === stage.id}
              onDragStart={setDraggingId}
              onDragEnd={() => {
                setDraggingId(null);
                setOverStageId(null);
              }}
              onDragOverColumn={setOverStageId}
              onDragLeaveColumn={() => setOverStageId(null)}
              onDropOnColumn={(stageId) => {
                const id = draggingId;
                if (id) void moveDeal(id, stageId);
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}
