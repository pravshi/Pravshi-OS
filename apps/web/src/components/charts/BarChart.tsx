type BarDatum = {
  /** Category label shown under the bar. */
  label: string;
  /** Numeric value for the bar. Negative values are treated as zero. */
  value: number;
};

export type BarChartProps = {
  data: BarDatum[];
  /** Accessible description of the chart. Falls back to an auto-generated summary. */
  ariaLabel?: string;
  /** Formats values shown above bars. Defaults to the raw number. */
  formatValue?: (value: number) => string;
  /** Maximum characters before a bar label is truncated with an ellipsis. */
  labelMaxLength?: number;
  /** Optional bar colour (CSS colour or variable). Defaults to the theme accent. */
  barColor?: string;
  className?: string;
};

const WIDTH = 400;
const HEIGHT = 260;
const PAD = { top: 26, right: 12, bottom: 30, left: 12 };
const BAR_RADIUS = 4;

/** Vertical bar chart rendered as pure SVG. No external dependencies. */
export function BarChart({
  data,
  ariaLabel,
  formatValue,
  labelMaxLength = 12,
  barColor,
  className,
}: BarChartProps) {
  const format = formatValue ?? ((v: number) => String(v));
  const sanitized = data.map((d) => ({ ...d, value: Math.max(0, d.value) }));
  const max = Math.max(...sanitized.map((d) => d.value), 0);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const n = sanitized.length;

  const summary =
    ariaLabel ??
    (n === 0
      ? 'Bar chart with no data'
      : `Bar chart with ${n} categories: ${sanitized
          .map((d) => `${d.label} ${format(d.value)}`)
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
          width={plotW}
          height={plotH}
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

  const slot = plotW / n;
  const barW = Math.min(slot * 0.58, 56);
  const fill = barColor ?? 'var(--color-brand)';

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={summary}
      className={className ?? 'h-auto w-full'}
    >
      <title>{summary}</title>
      {/* baseline */}
      <line
        x1={PAD.left}
        y1={HEIGHT - PAD.bottom}
        x2={WIDTH - PAD.right}
        y2={HEIGHT - PAD.bottom}
        stroke="var(--color-rule)"
        strokeWidth={1}
      />
      {sanitized.map((d, i) => {
        const barH = max === 0 ? 0 : (d.value / max) * (plotH - 4);
        const x = PAD.left + slot * i + (slot - barW) / 2;
        const y = HEIGHT - PAD.bottom - barH;
        const label =
          d.label.length > labelMaxLength ? `${d.label.slice(0, labelMaxLength - 1)}…` : d.label;
        return (
          <g key={`${d.label}-${i}`}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(barH, 0)}
              rx={BAR_RADIUS}
              fill={fill}
              opacity={0.88}
              style={{ transition: 'height 300ms ease, y 300ms ease, opacity 300ms ease' }}
            >
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
            <text
              x={x + barW / 2}
              y={y - 7}
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize={12}
            >
              {format(d.value)}
            </text>
            <text
              x={x + barW / 2}
              y={HEIGHT - PAD.bottom + 16}
              textAnchor="middle"
              fill="var(--color-ink-muted)"
              fontSize={11}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
