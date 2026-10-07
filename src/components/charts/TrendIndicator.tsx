export type TrendIndicatorProps = {
  /** Percentage change (e.g. 12 for +12%, -5 for −5%). */
  change: number;
  /** Accessible description. Falls back to an auto-generated summary. */
  ariaLabel?: string;
  /** Formats the percentage text. Defaults to one decimal + %. */
  formatChange?: (change: number) => string;
  /** Whether an upward change is good (green) — pass false for metrics like churn. */
  positiveIsGood?: boolean;
  /** Whether to show the arrow glyph. */
  showArrow?: boolean;
  className?: string;
};

const WIDTH = 96;
const HEIGHT = 28;

/**
 * Compact up/down trend indicator with a percentage change, rendered as pure SVG.
 * Colour semantics: uses theme ok/danger tokens. Never conveys direction by colour
 * alone — the arrow shape and explicit sign are always present.
 */
export function TrendIndicator({
  change,
  ariaLabel,
  formatChange,
  positiveIsGood = true,
  showArrow = true,
  className,
}: TrendIndicatorProps) {
  const format = formatChange ?? ((c: number) => `${c > 0 ? '+' : ''}${Math.round(c * 10) / 10}%`);
  const isUp = change > 0;
  const isFlat = change === 0;

  const directionWord = isFlat ? 'unchanged' : isUp ? 'up' : 'down';
  const summary = ariaLabel ?? `${directionWord} by ${format(change)}`;
  const good = isFlat ? null : isUp === positiveIsGood;
  const color =
    good === null ? 'var(--color-ink-muted)' : good ? 'var(--color-ok)' : 'var(--color-danger)';

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={summary}
      className={className ?? 'h-auto w-24'}
    >
      <title>{summary}</title>
      {showArrow && !isFlat && (
        <path
          d={isUp ? 'M8 20 L15 11 L22 20 Z' : 'M8 8 L15 17 L22 8 Z'}
          fill={color}
          style={{ transition: 'fill 300ms ease' }}
        />
      )}
      {showArrow && isFlat && <rect x={8} y={12.5} width={14} height={3} rx={1.5} fill={color} />}
      <text
        x={showArrow ? 30 : 8}
        y={18.5}
        fontSize={15}
        fontWeight={600}
        style={{ fill: color, fontVariantNumeric: 'tabular-nums', transition: 'fill 300ms ease' }}
      >
        {format(change)}
      </text>
    </svg>
  );
}
