import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

/**
 * Dependency-free SVG charts for the analytics dashboards.
 *
 * Rules followed everywhere:
 * - Empty or all-null data renders an inline "No data yet" note, never
 *   NaN/Infinity and never a broken axis.
 * - Charts are responsive via viewBox; text stays small and legible on
 *   desktop-first layouts.
 */

export const CHART_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d6', // cyan
  '#a855f7', // purple
  '#94a3b8', // slate
] as const;

/** Cycle-safe palette access (noUncheckedIndexedAccess-proof). */
export function colorAt(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length] ?? CHART_COLORS[0];
}

export function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        {/* h2 (not a div) so AT users can navigate dashboard sections as headings. */}
        <h2 className="text-sm font-medium">{title}</h2>
        {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function NoData({ what }: { what: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-md bg-muted/40">
      <p className="text-sm text-ink-muted">No data yet{what ? ` — ${what}` : ''}</p>
    </div>
  );
}

const W = 640;
const H = 240;
const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 30;

function yTicks(max: number): number[] {
  if (max <= 0) return [0];
  const step = max <= 5 ? 1 : Math.ceil(max / 4);
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

/** Time-series / sequence line chart. null buckets are skipped (gap), never 0. */
export function LineChart({
  data,
  color = CHART_COLORS[0],
  height = H,
  ariaLabel = 'Line chart',
}: {
  data: { label: string; value: number | null }[];
  color?: string;
  height?: number;
  /** Accessible name — thread the chart's title in at the call site. */
  ariaLabel?: string;
}) {
  const defined = data.filter((d) => d.value !== null) as { label: string; value: number }[];
  if (defined.length === 0) return <NoData what="nothing recorded in this range" />;

  const max = Math.max(...defined.map((d) => d.value), 1);
  const x = (i: number) => PAD_L + (i * (W - PAD_L - PAD_R)) / Math.max(data.length - 1, 1);
  const y = (v: number) => PAD_T + (height - PAD_T - PAD_B) * (1 - v / max);

  // Build a path that lifts the pen across null gaps.
  let path = '';
  data.forEach((d, i) => {
    if (d.value === null) {
      path += ' M'; // break the line
      return;
    }
    path += `${i === 0 || data[i - 1]?.value === null ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)} `;
  });

  const ticks = yTicks(max);
  const labelIdx =
    data.length <= 12 ? data.map((_, i) => i) : [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#6b7280">
            {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
      {defined.length <= 31 &&
        data.map((d, i) =>
          d.value === null ? null : (
            <circle key={i} cx={x(i)} cy={y(d.value)} r={3} fill={color}>
              <title>{`${d.label}: ${d.value}`}</title>
            </circle>
          ),
        )}
      {labelIdx.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={height - 10}
          textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
          fontSize={10}
          fill="#6b7280"
        >
          {data[i]?.label ?? ''}
        </text>
      ))}
    </svg>
  );
}

/** Horizontal bar chart — good for funnels, leaderboards, stage breakdowns. */
export function HBarChart({
  data,
  colorFor,
}: {
  data: { label: string; value: number; sub?: string }[];
  /** Optional per-row color (e.g. won/lost stage tinting). */
  colorFor?: (row: { label: string; value: number }, index: number) => string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (data.length === 0 || total === 0) return <NoData what="nothing recorded in this range" />;
  const max = Math.max(...data.map((d) => d.value));
  return (
    <div className="space-y-2.5">
      {/* Screen-reader summary: the rows are readable DOM, so no role="img" here. */}
      <p className="sr-only">Bar chart: {data.map((d) => `${d.label}: ${d.value}`).join('; ')}</p>
      {data.map((d, i) => {
        const color = colorFor ? colorFor(d, i) : colorAt(i);
        return (
          <div key={`${d.label}-${i}`} className="flex items-center gap-3">
            <div className="w-32 shrink-0 truncate text-xs text-ink-muted" title={d.label}>
              {d.label}
            </div>
            <div className="h-6 flex-1 overflow-hidden rounded bg-muted/60">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max((d.value / max) * 100, d.value > 0 ? 3 : 0)}%`,
                  backgroundColor: color,
                }}
                title={`${d.label}: ${d.value}${d.sub ? ` — ${d.sub}` : ''}`}
              />
            </div>
            <div className="w-14 shrink-0 text-right text-xs tabular-nums">{d.value}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Donut chart with legend and center total. */
export function DonutChart({
  segments,
  ariaLabel = 'Donut chart',
}: {
  segments: { label: string; value: number; color?: string }[];
  /** Accessible name — thread the chart's title in at the call site. */
  ariaLabel?: string;
}) {
  const total = segments.reduce((s, d) => s + d.value, 0);
  if (segments.length === 0 || total === 0) return <NoData what="nothing recorded in this range" />;

  const size = 180;
  const r = 70;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
      >
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e5e7eb" strokeWidth={26} />
        {segments.map((s, i) => {
          const frac = s.value / total;
          const dash = frac * circ;
          const offset = -acc * circ + circ / 4;
          acc += frac;
          return (
            <circle
              key={s.label}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color ?? colorAt(i)}
              strokeWidth={26}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={offset}
            >
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
        })}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={24}
          fontWeight={600}
          fill="currentColor"
        >
          {total}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize={11} fill="#6b7280">
          total
        </text>
      </svg>
      <ul className="space-y-1.5">
        {segments.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: s.color ?? colorAt(i) }}
            />
            <span className="text-ink-muted">{s.label}</span>
            <span className="font-medium tabular-nums">{s.value}</span>
            <span className="text-ink-muted tabular-nums">
              ({total > 0 ? ((s.value / total) * 100).toFixed(0) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stacked vertical bars — one bar per bucket, stacked segments per category. */
export function StackedBarChart({
  buckets,
  height = H,
  ariaLabel = 'Stacked bar chart',
}: {
  buckets: { label: string; segments: { label: string; value: number; color: string }[] }[];
  height?: number;
  /** Accessible name — thread the chart's title in at the call site. */
  ariaLabel?: string;
}) {
  const totals = buckets.map((b) => b.segments.reduce((s, seg) => s + seg.value, 0));
  const max = Math.max(...totals, 1);
  if (buckets.length === 0 || Math.max(...totals, 0) === 0)
    return <NoData what="nothing recorded in this range" />;

  const slot = (W - PAD_L - PAD_R) / buckets.length;
  const barW = Math.min(slot * 0.6, 44);
  const y = (v: number) => PAD_T + (height - PAD_T - PAD_B) * (1 - v / max);
  const ticks = yTicks(max);
  const labelIdx =
    buckets.length <= 10
      ? buckets.map((_, i) => i)
      : [0, Math.floor(buckets.length / 2), buckets.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#6b7280">
            {t}
          </text>
        </g>
      ))}
      {buckets.map((b, i) => {
        const total = totals[i] ?? 0;
        let acc = 0;
        const x = PAD_L + i * slot + (slot - barW) / 2;
        return (
          <g key={i}>
            {b.segments.map((seg) => {
              const h = (seg.value / max) * (height - PAD_T - PAD_B) || 0;
              const yTop = y(acc + seg.value);
              acc += seg.value;
              if (seg.value === 0) return null;
              return (
                <rect key={seg.label} x={x} y={yTop} width={barW} height={h} fill={seg.color}>
                  <title>{`${b.label} — ${seg.label}: ${seg.value}`}</title>
                </rect>
              );
            })}
            {total > 0 && (
              <text
                x={x + barW / 2}
                y={y(total) - 4}
                textAnchor="middle"
                fontSize={10}
                fill="#6b7280"
              >
                {total}
              </text>
            )}
          </g>
        );
      })}
      {labelIdx.map((i) => (
        <text
          key={i}
          x={PAD_L + i * slot + slot / 2}
          y={height - 10}
          textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}
          fontSize={10}
          fill="#6b7280"
        >
          {buckets[i]?.label ?? ''}
        </text>
      ))}
    </svg>
  );
}
