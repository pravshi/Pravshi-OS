type LineDatum = {
  /** Point label (e.g. a date). Used on the x axis and in the accessible summary. */
  label: string;
  /** Numeric value for the point. */
  value: number;
};

export type LineChartProps = {
  points: LineDatum[];
  /** Accessible description of the chart. Falls back to an auto-generated summary. */
  ariaLabel?: string;
  /** Formats values shown on the y-axis gridlines. */
  formatValue?: (value: number) => string;
  /** Number of horizontal gridlines. */
  gridlines?: number;
  /** Whether to fill the area under the line with a subtle accent wash. */
  showArea?: boolean;
  className?: string;
};

const WIDTH = 400;
const HEIGHT = 260;
const PAD = { top: 18, right: 12, bottom: 30, left: 44 };

/** Time-series line chart with dots and gridlines, rendered as pure SVG. */
export function LineChart({
  points,
  ariaLabel,
  formatValue,
  gridlines = 4,
  showArea = true,
  className,
}: LineChartProps) {
  const format = formatValue ?? ((v: number) => String(v));
  const n = points.length;

  const summary =
    ariaLabel ??
    (n === 0
      ? 'Line chart with no data'
      : `Line chart with ${n} points: ${points
          .map((p) => `${p.label} ${format(p.value)}`)
          .join(', ')}`);

  if (n === 0) {
    return (
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        className={className ?? 'h-auto w-full'}
      >
        <title>{summary}</title>
        <rect
          x={PAD.left}
          y={PAD.top}
          width={WIDTH - PAD.left - PAD.right}
          height={HEIGHT - PAD.top - PAD.bottom}
          rx={8}
          fill="none"
          stroke="var(--color-rule)"
          strokeDasharray="6 4"
        />
        <text
          x={WIDTH / 2}
          y={HEIGHT / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-ink-muted)"
          fontSize={13}
        >
          No data to display
        </text>
      </svg>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min === 0 ? 1 : max - min;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const xFor = (i: number) => (n === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW);
  const yFor = (v: number) => PAD.top + (1 - (v - min) / span) * plotH;

  const firstLabel = points[0]?.label ?? '';
  const lastLabel = points[points.length - 1]?.label ?? '';
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(p.value).toFixed(2)}`)
    .join(' ');

  const ticks = Array.from({ length: gridlines + 1 }, (_, i) => min + (span * i) / gridlines);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={summary}
      className={className ?? 'h-auto w-full'}
    >
      <title>{summary}</title>
      {/* gridlines + y labels */}
      {ticks.map((t, i) => {
        const y = yFor(t);
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={y}
              x2={WIDTH - PAD.right}
              y2={y}
              stroke="var(--color-rule)"
              strokeWidth={1}
              opacity={0.7}
            />
            <text
              x={PAD.left - 8}
              y={y + 4}
              textAnchor="end"
              fill="var(--color-ink-muted)"
              fontSize={11}
            >
              {format(Math.round(t * 100) / 100)}
            </text>
          </g>
        );
      })}
      {/* area wash */}
      {showArea && (
        <path
          d={`${path} L${xFor(n - 1).toFixed(2)},${(PAD.top + plotH).toFixed(2)} L${xFor(0).toFixed(2)},${(PAD.top + plotH).toFixed(2)} Z`}
          fill="var(--color-brand)"
          opacity={0.08}
        />
      )}
      {/* line */}
      <path
        d={path}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'd 300ms ease' }}
      />
      {/* dots + x labels */}
      {points.map((p, i) => (
        <g key={`${p.label}-${i}`}>
          <circle
            cx={xFor(i)}
            cy={yFor(p.value)}
            r={3.5}
            fill="var(--color-surface)"
            stroke="var(--color-brand)"
            strokeWidth={2}
          >
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
          {n <= 8 && (
            <text
              x={xFor(i)}
              y={HEIGHT - PAD.bottom + 16}
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize={11}
            >
              {p.label}
            </text>
          )}
        </g>
      ))}
      {/* first/last x labels when too many points for all */}
      {n > 8 && (
        <>
          <text
            x={xFor(0)}
            y={HEIGHT - PAD.bottom + 16}
            textAnchor="start"
            fill="var(--color-ink-muted)"
            fontSize={11}
          >
            {firstLabel}
          </text>
          <text
            x={xFor(n - 1)}
            y={HEIGHT - PAD.bottom + 16}
            textAnchor="end"
            fill="var(--color-ink-muted)"
            fontSize={11}
          >
            {lastLabel}
          </text>
        </>
      )}
    </svg>
  );
}
