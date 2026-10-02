'use client';

import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/components/crm/format';
import type { PipelineStage, VelocityStageRow } from '@/components/crm/types';
import { DealCard } from './DealCard';
import type { BoardDeal } from './board-types';

function columnTotal(deals: BoardDeal[]): number {
  return deals.reduce((sum, d) => {
    const v = d.value === null || d.value === '' ? NaN : Number(d.value);
    return sum + (Number.isNaN(v) ? 0 : v);
  }, 0);
}

/** One kanban column: stage header + droppable deal list. Native HTML5 DnD. */
export function StageColumn({
  stage,
  deals,
  velocity,
  showVelocity,
  canMove,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropOnColumn,
}: {
  stage: PipelineStage;
  deals: BoardDeal[];
  velocity: VelocityStageRow | null;
  showVelocity: boolean;
  canMove: boolean;
  isDragOver: boolean;
  onDragStart: (dealId: string) => void;
  onDragEnd: () => void;
  onDragOverColumn: (stageId: string) => void;
  onDragLeaveColumn: () => void;
  onDropOnColumn: (stageId: string) => void;
}) {
  const total = columnTotal(deals);
  return (
    <section
      aria-label={`Stage: ${stage.name}`}
      onDragOver={(e) => {
        if (!canMove) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOverColumn(stage.id);
      }}
      onDragLeave={onDragLeaveColumn}
      onDrop={(e) => {
        if (!canMove) return;
        e.preventDefault();
        onDropOnColumn(stage.id);
      }}
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-surface transition-colors ${
        isDragOver ? 'border-ink bg-accent' : 'border-line'
      }`}
    >
      <header className="flex items-start gap-2 border-b border-line p-3">
        <span
          aria-hidden
          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: stage.color ?? '#94a3b8' }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{stage.name}</h3>
            <Badge variant="secondary" className="shrink-0">
              {deals.length}
            </Badge>
            {stage.isWon && <Badge className="shrink-0 bg-ok/10 text-ok dark:bg-ok/20">Won</Badge>}
            {stage.isLost && (
              <Badge className="shrink-0 bg-danger/10 text-danger dark:bg-danger/20">Lost</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">
            {formatMoney(String(total), deals[0]?.currency ?? 'INR')}
            {showVelocity && velocity && (
              <span className="ml-2">
                · {velocity.avgDays === null ? '—' : `${velocity.avgDays.toFixed(1)}d`} avg
              </span>
            )}
          </p>
        </div>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {deals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            draggable={canMove}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
        {deals.length === 0 && (
          <p className="rounded border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">
            {canMove ? 'Drop deals here' : 'No deals'}
          </p>
        )}
      </div>
    </section>
  );
}
