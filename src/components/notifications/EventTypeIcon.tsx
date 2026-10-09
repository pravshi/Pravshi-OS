import {
  AlarmClock,
  AtSign,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FolderKanban,
  GitBranch,
  Handshake,
  Megaphone,
  UserPlus,
  XCircle,
  ZapOff,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import type { NotificationEventType } from '@/lib/notifications/types';

const ICONS: Record<NotificationEventType, LucideIcon> = {
  TASK_ASSIGNED: UserPlus,
  TASK_COMPLETED: ClipboardCheck,
  TASK_DUE: Clock,
  TASK_OVERDUE: AlarmClock,
  PROJECT_UPDATED: FolderKanban,
  DEAL_UPDATED: Handshake,
  DEAL_STAGE_CHANGED: GitBranch,
  WORKFLOW_SUCCEEDED: CheckCircle2,
  WORKFLOW_FAILED: XCircle,
  AUTOMATION_FAILED: ZapOff,
  MENTION: AtSign,
  SYSTEM_ALERT: Megaphone,
};

/** Small leading icon per notification event type.
 */
export function EventTypeIcon({
  type,
  className,
}: {
  type: NotificationEventType;
  className?: string;
}) {
  const Icon = ICONS[type] ?? Megaphone;
  return <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden />;
}
