import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDate, formatMoney } from '@/components/crm/format';
import type { ActionConfig, ConditionNode, Workflow } from '../_types';

/**
 * WorkflowSummary — WHEN / IF / THEN cards for the detail page.
 *
 * Renders the stored trigger/conditions/actions in human-readable form, e.g.
 * "When a deal's stage changes → If deal value > ₹100,000 → Then create task".
 * Purely presentational: no raw UUIDs, no full payload dumps — uuid-valued
 * references render as generic "a team member" / "a project" style labels.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_RE = /^\{\{([a-zA-Z0-9_.]+)\}\}$/;

const TRIGGER_LABELS: Record<string, string> = {
  'deal.created': 'a deal is created',
  'deal.updated': 'a deal is updated',
  'deal.stage_changed': "a deal's stage changes",
  'task.created': 'a task is created',
  'task.status_changed': "a task's status changes",
  'task.assigned': 'a task is assigned',
  'project.created': 'a project is created',
  manual: 'run manually',
  scheduled: 'on a schedule',
  webhook: 'via webhook',
  'task.overdue': 'a task becomes overdue',
};

const FIELD_LABELS: Record<string, string> = {
  'deal.value': 'Deal value',
  'deal.stage': 'Deal stage',
  'deal.is_won': 'Deal won',
  'deal.is_lost': 'Deal lost',
  'deal.probability': 'Deal probability',
  'deal.owner_person_id': 'Deal owner',
  'deal.pipeline_id': 'Deal pipeline',
  'deal.title': 'Deal title',
  'task.status': 'Task status',
  'task.priority': 'Task priority',
  'task.assignee_person_id': 'Task assignee',
  'task.project_id': 'Task project',
  'task.due_date': 'Task due date',
  'project.name': 'Project name',
  'project.is_archived': 'Project archived',
  'event.actor_person_id': 'Triggered by',
  'event.type': 'Trigger event',
};

const OPERATOR_LABELS: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  greater_than: '>',
  greater_than_or_equal: '≥',
  less_than: '<',
  less_than_or_equal: '≤',
  exists: 'is set',
  not_exists: 'is not set',
  in: 'is one of',
  not_in: 'is none of',
};

const ACTION_LABELS: Record<string, string> = {
  create_task: 'Create task',
  create_project: 'Create project',
  update_deal: 'Update deal',
  update_task: 'Update task',
  assign_task: 'Assign task',
  link_deal_project: 'Link project to deal',
};

/** Generic display for uuid-valued references — the UI never shows raw UUIDs. */
const UUID_DISPLAY: Record<string, string> = {
  'deal.owner_person_id': 'a team member',
  'deal.pipeline_id': 'a pipeline',
  'task.assignee_person_id': 'a team member',
  'task.project_id': 'a project',
  'event.actor_person_id': 'a team member',
};

function humanizeTemplate(value: string): string {
  const m = TEMPLATE_RE.exec(value.trim());
  if (!m) return value;
  switch (m[1]) {
    case 'event.entityId':
      return 'the triggering record';
    case 'event.dealId':
    case 'deal.id':
      return 'the triggering deal';
    case 'event.taskId':
    case 'task.id':
      return 'the triggering task';
    case 'event.projectId':
    case 'project.id':
      return 'the triggering project';
    default:
      return `the value of ${m[1]}`;
  }
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function describeScalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' && UUID_RE.test(value)) return 'a record';
  if (typeof value === 'string' && TEMPLATE_RE.test(value.trim())) return humanizeTemplate(value);
  return String(value);
}

function describeConditionValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((v) => describeConditionValue(field, v)).join(', ');
  if (typeof value === 'string' && UUID_RE.test(value)) return UUID_DISPLAY[field] ?? 'a record';
  if (typeof value === 'string' && TEMPLATE_RE.test(value.trim())) return humanizeTemplate(value);
  if (field === 'deal.value') return formatMoney(String(value), 'INR');
  if (field === 'deal.probability') return `${value}%`;
  return String(value);
}

// P2-3: defensive — a hand-edited corrupt row (trigger null / not an object)
// renders a fallback line instead of 500ing the detail page.
function describeTrigger(trigger: unknown): string {
  if (typeof trigger !== 'object' || trigger === null) {
    return 'When an unknown trigger fires (this workflow definition is corrupt)';
  }
  const t = trigger as { type?: unknown; entityType?: unknown; filters?: unknown };
  const type = typeof t.type === 'string' ? t.type : null;
  const base = type === null ? 'an unknown trigger' : (TRIGGER_LABELS[type] ?? type);
  let text = `When ${base}`;
  if (typeof t.entityType === 'string' && t.entityType) text += ` (a ${t.entityType})`;
  const filters =
    typeof t.filters === 'object' && t.filters !== null ? Object.entries(t.filters) : [];
  if (filters.length > 0) {
    text += ` where ${filters.map(([k, v]) => `${humanizeKey(k)}: ${describeScalar(v)}`).join(', ')}`;
  }
  return text;
}

function isGroup(node: ConditionNode): node is Extract<ConditionNode, { operator: 'AND' | 'OR' }> {
  return 'conditions' in node;
}

function ConditionTree({ node }: { node: ConditionNode }) {
  if (!isGroup(node)) {
    const field = FIELD_LABELS[node.field] ?? node.field;
    const op = OPERATOR_LABELS[node.operator] ?? node.operator;
    const value =
      node.operator === 'exists' || node.operator === 'not_exists'
        ? null
        : describeConditionValue(node.field, node.value);
    return (
      <p className="text-sm">
        <span className="font-medium">{field}</span> <span className="text-ink-muted">{op}</span>{' '}
        {value !== null && <span className="font-medium">{value}</span>}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {node.conditions.map((child, i) => (
        <div key={i} className="flex items-start gap-2">
          {i > 0 && (
            <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
              {node.operator}
            </Badge>
          )}
          <div className={i > 0 ? '' : 'ml-0'}>
            {isGroup(child) ? (
              <div className="border-l-2 border-line pl-3">
                <ConditionTree node={child} />
              </div>
            ) : (
              <ConditionTree node={child} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function describeAction(action: ActionConfig): { title: string; details: string[] } {
  const params = action.params as Record<string, unknown>;
  const label = ACTION_LABELS[action.type] ?? action.type;
  const safe = (v: unknown): string | null =>
    typeof v === 'string' && TEMPLATE_RE.test(v.trim()) ? humanizeTemplate(v) : null;
  switch (action.type) {
    case 'create_task': {
      const details: string[] = [];
      if (params.projectId !== undefined)
        details.push(safe(params.projectId) ? `In ${safe(params.projectId)}` : 'In a project');
      if (params.priority) details.push(`Priority ${String(params.priority)}`);
      if (params.dueDate) details.push(`Due ${formatDate(String(params.dueDate))}`);
      if (params.assigneePersonId !== undefined) details.push('Assigned to a team member');
      return { title: `${label} “${String(params.title ?? 'untitled')}”`, details };
    }
    case 'create_project': {
      const details: string[] = [];
      const dealRef = safe(params.dealId);
      if (params.dealId !== undefined)
        details.push(dealRef ? `Linked to ${dealRef}` : 'Linked to a deal');
      return { title: `${label} “${String(params.name ?? 'untitled')}”`, details };
    }
    case 'update_deal': {
      const details: string[] = [];
      if (params.probability !== undefined) details.push(`Probability → ${params.probability}%`);
      if (params.expectedCloseDate)
        details.push(`Expected close → ${formatDate(String(params.expectedCloseDate))}`);
      return { title: `${label} on the triggering deal`, details };
    }
    case 'update_task': {
      const details: string[] = [];
      if (params.status) details.push(`Status → ${String(params.status).replace(/_/g, ' ')}`);
      if (params.priority) details.push(`Priority → ${String(params.priority)}`);
      if (params.dueDate) details.push(`Due date → ${formatDate(String(params.dueDate))}`);
      return { title: `${label} on the triggering task`, details };
    }
    case 'assign_task':
      return { title: `${label} to a team member`, details: [] };
    case 'link_deal_project':
      return { title: `${label} — connects a project to its deal`, details: [] };
    default:
      return { title: label, details: [] };
  }
}

export function WorkflowSummary({ workflow }: { workflow: Workflow }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold tracking-widest text-ink-muted uppercase">
            When
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">{describeTrigger(workflow.trigger)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold tracking-widest text-ink-muted uppercase">
            If
          </CardTitle>
        </CardHeader>
        <CardContent>
          {workflow.conditions.length === 0 ? (
            <p className="text-sm text-ink-muted">Always runs — no conditions.</p>
          ) : (
            <div className="space-y-2">
              {workflow.conditions.map((node, i) => (
                <ConditionTree key={i} node={node} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold tracking-widest text-ink-muted uppercase">
            Then
          </CardTitle>
        </CardHeader>
        <CardContent>
          {workflow.actions.length === 0 ? (
            <p className="text-sm text-ink-muted">No actions yet.</p>
          ) : (
            <ol className="space-y-2.5">
              {workflow.actions.map((action, i) => {
                const { title, details } = describeAction(action);
                return (
                  <li key={i} className="flex items-start gap-2">
                    <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">
                      {i + 1}
                    </Badge>
                    <div>
                      <p className="text-sm font-medium">{title}</p>
                      {details.map((d, j) => (
                        <p key={j} className="text-xs text-ink-muted">
                          {d}
                        </p>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
