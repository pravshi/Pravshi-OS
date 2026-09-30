import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/components/crm/format';
import type { Forecast, PipelineStage } from '@/components/crm/types';

/**
 * Forecast strip above the board: per-stage weighted pipeline value plus
 * org-wide totals. Money arrives as numeric strings; formatMoney parses them.
 */
export function ForecastBar({
  forecast,
  stages,
}: {
  forecast: Forecast | null;
  stages: PipelineStage[];
}) {
  if (!forecast) {
    return (
      <p className="text-sm text-ink-muted">
        Forecast is unavailable — you may not have permission to view it.
      </p>
    );
  }
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const currency = 'INR';
  return (
    <Card>
      <CardContent className="flex flex-wrap items-stretch gap-4 p-4">
        <div className="min-w-40">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Total pipeline</p>
          <p className="mt-1 text-xl font-semibold">
            {formatMoney(forecast.totals.totalValue, currency)}
          </p>
          <p className="text-xs text-ink-muted">{forecast.totals.dealCount} deals</p>
        </div>
        <div className="min-w-40">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Weighted forecast</p>
          <p className="mt-1 text-xl font-semibold text-brand">
            {formatMoney(forecast.totals.weightedValue, currency)}
          </p>
          <p className="text-xs text-ink-muted">probability-weighted</p>
        </div>
        <div className="flex flex-1 flex-wrap items-stretch gap-3">
          {forecast.stages.map((row) => (
            <div
              key={row.stageId}
              className="min-w-28 flex-1 rounded-md border border-line bg-ground px-3 py-2"
              title={`${row.dealCount} deals · ${row.probability}% probability`}
            >
              <p className="truncate text-xs font-medium">
                {stageName.get(row.stageId) ?? row.stageName}
              </p>
              <p className="mt-0.5 text-sm font-semibold">
                {formatMoney(row.weightedValue, currency)}
              </p>
              <p className="text-xs text-ink-muted">
                {row.dealCount} deals · {row.probability}%
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
