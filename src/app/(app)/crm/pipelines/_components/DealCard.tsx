'use client';

import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney, shortOwnerId } from '@/components/crm/format';
import type { BoardDeal } from './board-types';

/** A draggable deal card on the kanban board. */
export function DealCard({
  deal,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  deal: BoardDeal;
  draggable: boolean;
  onDragStart: (dealId: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <Card
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', deal.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(deal.id);
      }}
      onDragEnd={onDragEnd}
      className={draggable ? 'cursor-grab active:cursor-grabbing' : undefined}
    >
      <CardContent className="space-y-1.5 p-3">
        <Link
          href={`/crm/deals/${deal.id}`}
          className="block text-sm font-medium leading-snug hover:underline"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
        >
          {deal.title}
        </Link>
        <p className="text-sm font-semibold">{formatMoney(deal.value, deal.currency)}</p>
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span className="truncate">{deal.companyName ?? 'No company'}</span>
          <span className="ml-2 shrink-0" title={`Owner person ${deal.ownerPersonId}`}>
            {shortOwnerId(deal.ownerPersonId)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
