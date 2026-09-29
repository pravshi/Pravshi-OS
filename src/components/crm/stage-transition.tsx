'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { isErrorEnvelope, type CrmResult, type Deal, type DealStage } from './types';
import { DEAL_STAGE_LABELS, formatDate, nextStages, stageBadgeClasses } from './format';

/**
 * Deal stage lifecycle UI: shows the current stage and offers only forward
 * transitions (plus Mark Lost). Closing is server-stamped (closed_at) by the
 * migration trigger; reopening clears it, so no manual date input here.
 */
export function StageTransition({
  deal,
  onTransition,
  disabled,
}: {
  deal: Deal;
  onTransition: (id: string, input: { stage: DealStage }) => Promise<CrmResult<Deal>>;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<DealStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = nextStages(deal.stage);

  async function moveTo(stage: DealStage) {
    setPending(stage);
    setError(null);
    try {
      const result = await onTransition(deal.id, { stage });
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        router.refresh();
      }
    } catch {
      setError('The stage change failed. Please try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-sm text-ink-muted">Stage</span>
        <Badge className={stageBadgeClasses(deal.stage)}>{DEAL_STAGE_LABELS[deal.stage]}</Badge>
        {deal.closed_at && (
          <span className="text-sm text-ink-muted">Closed {formatDate(deal.closed_at)}</span>
        )}
      </div>
      {options.length > 0 && !disabled && (
        <div className="flex flex-wrap gap-2">
          {options.map((s) => (
            <Button
              key={s}
              variant={s === 'LOST' ? 'destructive' : 'outline'}
              size="sm"
              disabled={pending !== null}
              onClick={() => moveTo(s)}
            >
              {pending === s ? 'Moving…' : `Move to ${DEAL_STAGE_LABELS[s]}`}
            </Button>
          ))}
        </div>
      )}
      {options.length === 0 && (
        <p className="text-sm text-ink-muted">
          This deal is closed. Reopening a deal happens through the edit form.
        </p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
