'use client';

import {
  CONDITION_FIELD_GROUPS,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  OPERATOR_LABELS,
  conditionFieldKind,
  enumOptionsForField,
} from './schemas';
import {
  countConditionLeaves,
  maxConditionDepth,
  type ConditionFieldKind,
  type ConditionLeaf,
  type ConditionNode,
  type ConditionOperator,
} from '@/lib/workflows/schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/crm/pickers';

const selectClasses =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

const checkboxClasses =
  'h-4 w-4 rounded border-line accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

// ── Tree editing helpers (immutable, path = index list) ──────────────────────

type Path = readonly number[];

function replaceAt(nodes: ConditionNode[], path: Path, node: ConditionNode): ConditionNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return nodes;
  return nodes.map((child, i) => {
    if (i !== head) return child;
    if (rest.length === 0) return node;
    if (!('conditions' in child)) return child;
    return { ...child, conditions: replaceAt([...child.conditions], rest, node) };
  });
}

function removeAt(nodes: ConditionNode[], path: Path): ConditionNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return nodes;
  if (rest.length === 0) return nodes.filter((_, i) => i !== head);
  return nodes.map((child, i) => {
    if (i !== head || !('conditions' in child)) return child;
    return { ...child, conditions: removeAt([...child.conditions], rest) };
  });
}

function defaultLeaf(): ConditionLeaf {
  return { field: 'deal.value', operator: 'greater_than', value: 0 };
}

// ── Value coercion per field kind ─────────────────────────────────────────────

function coerceValue(kind: ConditionFieldKind, raw: string): unknown {
  switch (kind) {
    case 'numeric': {
      const trimmed = raw.trim();
      return trimmed === '' ? trimmed : Number(trimmed);
    }
    case 'boolean':
      return raw === 'true';
    default:
      return raw;
  }
}

function valueToInput(kind: ConditionFieldKind, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  return String(value);
}

const NO_VALUE_OPERATORS: ConditionOperator[] = ['exists', 'not_exists'];
const LIST_OPERATORS: ConditionOperator[] = ['in', 'not_in'];

// ── Leaf editor ──────────────────────────────────────────────────────────────

function LeafEditor({
  leaf,
  fieldId,
  onChange,
  onRemove,
}: {
  leaf: ConditionLeaf;
  /** Unique DOM id prefix for this leaf (Nit-5: two leaves may share a field). */
  fieldId: string;
  onChange: (leaf: ConditionLeaf) => void;
  onRemove: () => void;
}) {
  const kind = conditionFieldKind(leaf.field) ?? 'text';
  const enumOptions = enumOptionsForField(leaf.field);
  const noValue = NO_VALUE_OPERATORS.includes(leaf.operator);
  const isList = LIST_OPERATORS.includes(leaf.operator);
  const isEnumList = isList && enumOptions !== null;

  function setField(field: string) {
    const nextKind = conditionFieldKind(field) ?? 'text';
    const nextOperator: ConditionOperator = 'equals';
    const raw = nextKind === 'boolean' ? 'false' : nextKind === 'numeric' ? '0' : '';
    onChange({ field, operator: nextOperator, value: coerceValue(nextKind, raw) });
  }

  function setOperator(operator: ConditionOperator) {
    if (NO_VALUE_OPERATORS.includes(operator)) {
      // exists/not_exists must not carry a value — drop it.
      onChange({ field: leaf.field, operator });
      return;
    }
    const raw = valueToInput(kind, leaf.value);
    onChange({ ...leaf, operator, value: coerceValue(kind, raw) });
  }

  function setValue(raw: string) {
    if (isList) {
      onChange({
        ...leaf,
        value: raw
          .split(',')
          .map((part) => coerceValue(kind, part.trim()))
          .filter((part) => part !== ''),
      });
      return;
    }
    onChange({ ...leaf, value: coerceValue(kind, raw) });
  }

  /** P2-6: multi-select values for list operators on enum fields. */
  function setListValue(values: string[]) {
    onChange({
      ...leaf,
      value: values.map((v) => coerceValue(kind, v)).filter((v) => v !== ''),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`${fieldId}-field`}>
        Condition field
      </label>
      <select
        id={`${fieldId}-field`}
        aria-label="Condition field"
        className={`${selectClasses} max-w-52`}
        value={leaf.field}
        onChange={(e) => setField(e.target.value)}
      >
        {CONDITION_FIELD_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.fields.map((f) => (
              <option key={f.field} value={f.field}>
                {f.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <select
        aria-label="Operator"
        className={selectClasses}
        value={leaf.operator}
        onChange={(e) => setOperator(e.target.value as ConditionOperator)}
      >
        {Object.entries(OPERATOR_LABELS).map(([op, label]) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>

      {!noValue && (
        <>
          {kind === 'boolean' ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Value true"
                className={checkboxClasses}
                checked={leaf.value === true}
                onChange={(e) => setValue(e.target.checked ? 'true' : 'false')}
              />
              true
            </label>
          ) : isEnumList ? (
            <select
              multiple
              aria-label="Values"
              className={selectClasses}
              size={Math.min((enumOptions ?? []).length, 4)}
              value={Array.isArray(leaf.value) ? leaf.value.map(String) : []}
              onChange={(e) =>
                setListValue(Array.from(e.target.selectedOptions, (opt) => opt.value))
              }
            >
              {(enumOptions ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : enumOptions ? (
            <select
              aria-label="Value"
              className={selectClasses}
              value={valueToInput(kind, leaf.value)}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="">— choose —</option>
              {enumOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : kind === 'date' ? (
            <Input
              type="date"
              aria-label="Value date"
              className="w-40"
              value={valueToInput(kind, leaf.value)}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : kind === 'numeric' ? (
            <Input
              type="number"
              aria-label="Value number"
              className="w-32"
              value={valueToInput(kind, leaf.value)}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Input
              type="text"
              aria-label={isList ? 'Values (comma separated)' : 'Value'}
              className="w-56"
              placeholder={kind === 'uuid' ? 'uuid' : isList ? 'comma, separated, values' : 'value'}
              value={
                isList
                  ? Array.isArray(leaf.value)
                    ? leaf.value.join(', ')
                    : ''
                  : valueToInput(kind, leaf.value)
              }
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        aria-label="Remove condition"
      >
        ✕
      </Button>
    </div>
  );
}

// ── Recursive node editor ────────────────────────────────────────────────────

function NodeEditor({
  nodes,
  node,
  path,
  onChangeTree,
  leafCount,
  boundNotice,
}: {
  nodes: ConditionNode[];
  node: ConditionNode;
  path: Path;
  onChangeTree: (nodes: ConditionNode[]) => void;
  leafCount: number;
  boundNotice: string | null;
}) {
  const isGroup = 'conditions' in node;
  const depth = path.length; // root array = 0; group at path length p sits at depth p+1

  if (!isGroup) {
    return (
      <LeafEditor
        leaf={node}
        fieldId={`wf-cond-${path.join('-')}`}
        onChange={(leaf) => onChangeTree(replaceAt(nodes, path, leaf))}
        onRemove={() => onChangeTree(removeAt(nodes, path))}
      />
    );
  }

  // A new group carries a leaf child (groups must not be empty): it adds 2 to
  // depth, so it is allowed only while depth + 2 ≤ MAX_CONDITION_DEPTH.
  const canAddGroup = depth + 2 <= MAX_CONDITION_DEPTH;
  const canAddLeaf = leafCount < MAX_CONDITION_LEAVES;

  return (
    <div className="rounded-md border border-line bg-muted/30 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Group logic"
          className="inline-flex overflow-hidden rounded-md border border-line"
        >
          {(['AND', 'OR'] as const).map((op) => (
            <button
              key={op}
              type="button"
              aria-pressed={node.operator === op}
              onClick={() => onChangeTree(replaceAt(nodes, path, { ...node, operator: op }))}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                node.operator === op
                  ? 'bg-foreground text-background'
                  : 'bg-transparent text-ink-muted hover:text-foreground'
              }`}
            >
              {op === 'AND' ? 'All of' : 'Any of'}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-muted">
          {node.operator === 'AND' ? 'every condition must hold' : 'at least one must hold'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => onChangeTree(removeAt(nodes, path))}
          aria-label="Remove group"
        >
          ✕
        </Button>
      </div>

      <div className="space-y-2">
        {node.conditions.map((child, i) => (
          <NodeEditor
            key={i}
            nodes={nodes}
            node={child}
            path={[...path, i]}
            onChangeTree={onChangeTree}
            leafCount={leafCount}
            boundNotice={boundNotice}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAddLeaf}
          onClick={() =>
            onChangeTree(
              replaceAt(nodes, path, {
                ...node,
                conditions: [...node.conditions, defaultLeaf()],
              }),
            )
          }
        >
          + Condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAddLeaf || !canAddGroup}
          title={
            !canAddGroup
              ? `Nesting is capped at ${MAX_CONDITION_DEPTH} levels — flatten the logic instead`
              : undefined
          }
          onClick={() =>
            onChangeTree(
              replaceAt(nodes, path, {
                ...node,
                conditions: [...node.conditions, { operator: 'AND', conditions: [defaultLeaf()] }],
              }),
            )
          }
        >
          + Group
        </Button>
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export function ConditionBuilder({
  nodes,
  onChange,
  error,
}: {
  nodes: ConditionNode[];
  onChange: (nodes: ConditionNode[]) => void;
  error?: string;
}) {
  const leafCount = countConditionLeaves(nodes);
  const depth = maxConditionDepth(nodes);
  const leafBoundHit = leafCount >= MAX_CONDITION_LEAVES;
  const boundNotice = leafBoundHit
    ? `Condition limit reached (${MAX_CONDITION_LEAVES} conditions) — remove some to add more.`
    : null;

  function addLeaf() {
    if (leafBoundHit) return;
    onChange([...nodes, defaultLeaf()]);
  }

  function addGroup() {
    if (leafBoundHit) return;
    // Root-level group adds depth 2 — always within the depth-5 bound.
    onChange([...nodes, { operator: 'AND', conditions: [defaultLeaf()] }]);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-muted" aria-live="polite">
          {nodes.length === 0
            ? 'No conditions — the workflow runs for every matching event.'
            : `${leafCount} condition${leafCount === 1 ? '' : 's'} · depth ${depth}/${MAX_CONDITION_DEPTH}`}
        </p>
        {boundNotice && (
          <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {boundNotice}
          </p>
        )}
      </div>

      {nodes.length > 0 && (
        <div className="space-y-2">
          {nodes.map((node, i) => (
            <NodeEditor
              key={i}
              nodes={nodes}
              node={node}
              path={[i]}
              onChangeTree={onChange}
              leafCount={leafCount}
              boundNotice={boundNotice}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={leafBoundHit} onClick={addLeaf}>
          + Add condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={leafBoundHit}
          onClick={addGroup}
        >
          + Add group
        </Button>
      </div>

      {error && <FieldError message={error} />}
    </div>
  );
}
