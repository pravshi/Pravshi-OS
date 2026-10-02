import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/components/crm/format';
import type { Forecast, ForecastCurrencyRow, PipelineStage } from '@/components/crm/types';

/**
 * Forecast strip above the board: per-stage weighted pipeline value plus
 * org-wide totals. Money arrives as numeric strings; formatMoney parses them.
 *
 * Currency-aware: deal values are grouped by currency (see
 * Forecast.totalsByCurrency / ForecastStageRow.byCurrency) and never summed
 * across currencies — each currency gets its own totals card and its own
 * per-stage line.
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
  // totalsByCurrency is always present from the service; the legacy `totals`
  // fallback keeps the component safe against older payloads.
  const totals: ForecastCurrencyRow[] =
    forecast.totalsByCurrency.length > 0
      ? forecast.totalsByCurrency
      : [
          {
            currency: 'INR',
            dealCount: forecast.totals.dealCount,
            totalValue: forecast.totals.totalValue,
            weightedValue: forecast.totals.weightedValue,
          },
        ];
  return (
    <Card>
      <CardContent className="flex flex-wrap items-stretch gap-4 p-4">
        {totals.map((t) => (
          <div key={t.currency} className="flex min-w-40 gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-muted">
                Total pipeline · {t.currency}
              </p>
              <p className="mt-1 text-xl font-semibold">{formatMoney(t.totalValue, t.currency)}</p>
              <p className="text-xs text-ink-muted">{t.dealCount} deals</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-muted">
                Weighted · {t.currency}
              </p>
              <p className="mt-1 text-xl font-semibold text-foreground">
                {formatMoney(t.weightedValue, t.currency)}
              </p>
              <p className="text-xs text-ink-muted">probability-weighted</p>
            </div>
          </div>
        ))}
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
              {row.byCurrency.length > 1 ? (
                row.byCurrency.map((c) => (
                  <p key={c.currency} className="mt-0.5 text-sm font-semibold">
                    {formatMoney(c.weightedValue, c.currency)}{' '}
                    <span className="text-xs font-normal text-ink-muted">{c.currency}</span>
                  </p>
                ))
              ) : (
                <p className="mt-0.5 text-sm font-semibold">
                  {formatMoney(
                    row.byCurrency[0]?.weightedValue ?? row.weightedValue,
                    row.byCurrency[0]?.currency ?? 'INR',
                  )}
                </p>
              )}
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
