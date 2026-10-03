import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';

/**
 * SubtaskCountBadge — the subtask count pill for TaskCard (Phase 4).
 * Apple-minimal: a quiet secondary pill; shows completion progress when some
 * subtasks are done. Renders nothing when there are no subtasks.
 */
export function SubtaskCountBadge({
  total,
  completed = 0,
  className,
}: {
  total: number;
  completed?: number;
  className?: string;
}) {
  if (total <= 0) return null;
  const done = Math.min(Math.max(completed, 0), total);
  const allDone = done === total;
  return (
    <Badge
      variant="secondary"
      className={cn('font-normal tabular-nums', allDone && 'text-muted-foreground', className)}
      aria-label={`${done} of ${total} subtasks completed`}
    >
      {done}/{total} subtasks
    </Badge>
  );
}
