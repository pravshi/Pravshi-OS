type DonutSegment = {
  /** Segment label (e.g. a pipeline stage). */
  label: string;
  /** Segment value. Negative values are treated as zero. */
  value: number;
  /** Optional override colour (CSS colour or variable). */
  color?: string;
};

export type DonutChartProps = {
  segments: DonutSegment[];
  /** Accessible description of the chart. Falls back to an auto-generated summary. */
  ariaLabel?: string;
  /** Label shown above the centre total (e.g. "Total deals"). */
  centerLabel?: string;
  /** Formats the centre total. Defaults to the raw number. */
  formatValue?: (value: number) => string;
  /** Whether to render the HTML legend beside the chart. */
  showLegend?: boolean;
  className?: string;
};

const SIZE = 220;
const RADIUS = 80;
const STROKE = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Muted, Apple-minimal palette built from theme variables so it adapts to dark mode. */
const DEFAULT_PALETTE = [
  'var(--color-brand)',
  'var(--color-ok)',
  'var(--color-warn)',
  'var(--color-danger)',
  'var(--color-ink-muted)',
  'var(--color-brand-soft)',
  'var(--color-rule)',
];

/** Donut chart for distributions, rendered as pure SVG. No external dependencies. */
export function DonutChart({
  segments,
  ariaLabel,
  centerLabel,
  formatValue,
  showLegend = true,
  className,
}: DonutChartProps) {
  const format = formatValue ?? ((v: number) => String(v));
  const sanitized = segments
    .map((s, i) => ({
      ...s,
      value: Math.max(0, s.value),
      color: s.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
    }))
    .filter((s) => s.value > 0);
  const total = sanitized.reduce((acc, s) => acc + s.value, 0);
  const center = SIZE / 2;

  const summary =
    ariaLabel ??
    (total === 0
      ? 'Donut chart with no data'
      : `Donut chart: ${sanitized.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`);

  if (total === 0) {
    return (
      <div className={className ?? ''}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={summary}
          className="h-auto w-full max-w-55"
        >
          <title>{summary}</title>
          <circle
            cx={center}
            cy={center}
            r={RADIUS}
            fill="none"
            stroke="var(--color-rule)"
            strokeWidth={STROKE}
            strokeDasharray="6 4"
          />
          <text
            x={center}
            y={center}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-ink-muted)"
            fontSize={13}
          >
            No data
          </text>
        </svg>
      </div>
    );
  }

  // Accumulate dash offsets so each arc starts where the previous ended.
  let offset = 0;
  const arcs = sanitized.map((s) => {
    const fraction = s.value / total;
    const dash = fraction * CIRCUMFERENCE;
    const arc = { ...s, dash, offset: offset };
    offset += dash;
    return arc;
  });

  return (
    <div className={className ?? ''}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={summary}
        className="h-auto w-full max-w-55"
      >
        <title>{summary}</title>
        <circle
          cx={center}
          cy={center}
          r={RADIUS}
          fill="none"
          stroke="var(--color-rule)"
          strokeWidth={STROKE}
          opacity={0.5}
        />
        {arcs.map((a, i) => (
          <circle
            key={`${a.label}-${i}`}
            cx={center}
            cy={center}
            r={RADIUS}
            fill="none"
            stroke={a.color}
            strokeWidth={STROKE}
            strokeDasharray={`${Math.max(a.dash - 1.5, 0.5)} ${CIRCUMFERENCE}`}
            strokeDashoffset={-a.offset + CIRCUMFERENCE / 4}
            strokeLinecap={sanitized.length === 1 ? 'round' : 'butt'}
            style={{ transition: 'stroke-dasharray 300ms ease, stroke-dashoffset 300ms ease' }}
          >
            <title>{`${a.label}: ${format(a.value)}`}</title>
          </circle>
        ))}
        {centerLabel && (
          <text
            x={center}
            y={center - 8}
            textAnchor="middle"
            fill="var(--color-ink-muted)"
            fontSize={11}
          >
            {centerLabel}
          </text>
        )}
        <text
          x={center}
          y={centerLabel ? center + 12 : center + 6}
          textAnchor="middle"
          fill="var(--color-ink)"
          fontSize={20}
          fontWeight={600}
        >
          {format(total)}
        </text>
      </svg>
      {showLegend && (
        <ul className="mt-3 flex flex-col gap-1.5" aria-hidden="true">
          {sanitized.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-[var(--color-ink)]">{s.label}</span>
              <span className="ml-auto text-[var(--color-ink-muted)] tabular-nums">
                {format(s.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
