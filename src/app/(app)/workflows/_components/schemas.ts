import {
  CONDITION_FIELD_TYPES,
  DEFERRED_ACTION_TYPES,
  DEFERRED_TRIGGER_TYPES,
  IMPLEMENTED_ACTION_TYPES,
  IMPLEMENTED_TRIGGER_TYPES,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  type ConditionFieldKind,
  type ConditionOperator,
  type ImplementedActionType,
  type ImplementedTriggerType,
} from '@/lib/workflows/schema';

/**
 * Workflow builder UI metadata (client-safe).
 *
 * The server schemas in @/lib/workflows/schema remain the validation source
 * of truth — this module carries ONLY presentation strings (labels, option
 * lists, template hints), derived from the same exported constants so the
 * option lists can never drift from what the server accepts. No zod mirror
 * schemas live here; the builder validates with CreateWorkflowSchema /
 * ConditionNodeSchema / ActionConfigSchema directly.
 */

export {
  CONDITION_FIELD_TYPES,
  DEFERRED_ACTION_TYPES,
  DEFERRED_TRIGGER_TYPES,
  IMPLEMENTED_ACTION_TYPES,
  IMPLEMENTED_TRIGGER_TYPES,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
};
export type {
  ConditionFieldKind,
  ConditionOperator,
  ImplementedActionType,
  ImplementedTriggerType,
};

export const TRIGGER_TYPE_LABELS: Record<ImplementedTriggerType, string> = {
  'deal.created': 'Deal created',
  'deal.updated': 'Deal updated',
  'deal.stage_changed': 'Deal stage changed',
  'task.created': 'Task created',
  'task.status_changed': 'Task status changed',
  'task.assigned': 'Task assigned',
  'project.created': 'Project created',
  manual: 'Manual run',
};

export const DEFERRED_TRIGGER_LABELS: Record<(typeof DEFERRED_TRIGGER_TYPES)[number], string> = {
  scheduled: 'Scheduled',
  webhook: 'Webhook',
  'task.overdue': 'Task overdue',
};

export const ACTION_TYPE_LABELS: Record<ImplementedActionType, string> = {
  create_task: 'Create task',
  create_project: 'Create project',
  update_deal: 'Update deal',
  update_task: 'Update task',
  assign_task: 'Assign task',
  link_deal_project: 'Link deal ↔ project',
};

export const DEFERRED_ACTION_LABELS: Record<(typeof DEFERRED_ACTION_TYPES)[number], string> = {
  send_notification: 'Send notification',
  send_email: 'Send email',
  webhook: 'Call webhook',
  run_ai_action: 'Run AI action',
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  greater_than: 'greater than',
  greater_than_or_equal: 'greater than or equal to',
  less_than: 'less than',
  less_than_or_equal: 'less than or equal to',
  exists: 'is set',
  not_exists: 'is not set',
  in: 'is one of',
  not_in: 'is not one of',
};

export interface ConditionFieldOption {
  field: string;
  label: string;
  kind: ConditionFieldKind;
}

/** Field select options grouped for <optgroup> rendering (audit §11.1 allowlist). */
export const CONDITION_FIELD_GROUPS: { label: string; fields: ConditionFieldOption[] }[] = [
  {
    label: 'Deal',
    fields: [
      { field: 'deal.title', label: 'Deal title', kind: 'text' },
      { field: 'deal.value', label: 'Deal value', kind: 'numeric' },
      { field: 'deal.probability', label: 'Deal probability (%)', kind: 'numeric' },
      { field: 'deal.stage', label: 'Deal stage (legacy)', kind: 'enum' },
      { field: 'deal.is_won', label: 'Deal is won', kind: 'boolean' },
      { field: 'deal.is_lost', label: 'Deal is lost', kind: 'boolean' },
      { field: 'deal.owner_person_id', label: 'Deal owner', kind: 'uuid' },
      { field: 'deal.pipeline_id', label: 'Deal pipeline', kind: 'uuid' },
    ],
  },
  {
    label: 'Task',
    fields: [
      { field: 'task.status', label: 'Task status', kind: 'enum' },
      { field: 'task.priority', label: 'Task priority', kind: 'enum' },
      { field: 'task.assignee_person_id', label: 'Task assignee', kind: 'uuid' },
      { field: 'task.project_id', label: 'Task project', kind: 'uuid' },
      { field: 'task.due_date', label: 'Task due date', kind: 'date' },
    ],
  },
  {
    label: 'Project',
    fields: [
      { field: 'project.name', label: 'Project name', kind: 'text' },
      { field: 'project.is_archived', label: 'Project archived', kind: 'boolean' },
    ],
  },
  {
    label: 'Event',
    fields: [
      { field: 'event.type', label: 'Event type', kind: 'text' },
      { field: 'event.actor_person_id', label: 'Triggering user', kind: 'uuid' },
    ],
  },
];

/** Safety check: the UI group lists above must cover exactly the server allowlist. */
export function conditionFieldKind(field: string): ConditionFieldKind | undefined {
  const kind = CONDITION_FIELD_TYPES[field];
  if (kind === undefined) return undefined;
  return kind;
}

/** Enum field options shown as selects instead of free text. */
export const DEAL_STAGE_OPTIONS = [
  'NEW',
  'QUALIFIED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;

export const TASK_STATUS_OPTIONS = ['todo', 'in_progress', 'done'] as const;
export const TASK_STATUS_OPTION_LABELS: Record<(typeof TASK_STATUS_OPTIONS)[number], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

export const TASK_PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'] as const;

export function enumOptionsForField(field: string): readonly string[] | null {
  switch (field) {
    case 'deal.stage':
      return DEAL_STAGE_OPTIONS;
    case 'task.status':
      return TASK_STATUS_OPTIONS;
    case 'task.priority':
      return TASK_PRIORITY_OPTIONS;
    default:
      return null;
  }
}

/**
 * `{{path}}` template references available in action params, per trigger
 * type (audit §12: substitution resolves against the fixed context
 * { event, deal, task, project } built from the trigger snapshot).
 *
 * Snapshot keys are the snake_case condition-snapshot keys the engine
 * builds (engine.ts toDealSnapshot/toTaskSnapshot/toProjectSnapshot);
 * the event object is the full WorkflowEvent (entityId, type, occurredAt,
 * actorPersonId, payload).
 */
export const TRIGGER_TEMPLATE_PATHS: Record<ImplementedTriggerType, string[]> = {
  'deal.created': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{deal.title}}',
    '{{deal.value}}',
    '{{deal.stage}}',
    '{{deal.is_won}}',
    '{{deal.is_lost}}',
    '{{deal.probability}}',
    '{{deal.owner_person_id}}',
    '{{deal.pipeline_id}}',
  ],
  'deal.updated': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{deal.title}}',
    '{{deal.value}}',
    '{{deal.stage}}',
    '{{deal.is_won}}',
    '{{deal.is_lost}}',
    '{{deal.probability}}',
    '{{deal.owner_person_id}}',
    '{{deal.pipeline_id}}',
  ],
  'deal.stage_changed': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{deal.title}}',
    '{{deal.value}}',
    '{{deal.stage}}',
    '{{deal.is_won}}',
    '{{deal.is_lost}}',
    '{{deal.probability}}',
  ],
  'task.created': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{task.status}}',
    '{{task.priority}}',
    '{{task.assignee_person_id}}',
    '{{task.project_id}}',
    '{{task.due_date}}',
  ],
  'task.status_changed': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{task.status}}',
    '{{task.priority}}',
    '{{task.assignee_person_id}}',
    '{{task.project_id}}',
    '{{task.due_date}}',
  ],
  'task.assigned': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{task.status}}',
    '{{task.priority}}',
    '{{task.assignee_person_id}}',
    '{{task.project_id}}',
  ],
  'project.created': [
    '{{event.entityId}}',
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{project.name}}',
    '{{project.is_archived}}',
  ],
  manual: [
    '{{event.type}}',
    '{{event.occurredAt}}',
    '{{event.actorPersonId}}',
    '{{event.payload.input}}',
  ],
};

/** Entity type suggested for narrowing when a trigger type is picked. */
export function suggestedEntityType(triggerType: string): 'deal' | 'task' | 'project' | undefined {
  if (triggerType.startsWith('deal.')) return 'deal';
  if (triggerType.startsWith('task.')) return 'task';
  if (triggerType === 'project.created') return 'project';
  return undefined;
}
