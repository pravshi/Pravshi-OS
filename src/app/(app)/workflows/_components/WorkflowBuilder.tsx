"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CreateWorkflowSchema,
  type ConditionNode,
  type TriggerConfig,
} from "@/lib/workflows/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, FieldError } from "@/components/crm/pickers";
import { LinkButton } from "@/components/crm/link-button";
import { TriggerPicker } from "./TriggerPicker";
import { ConditionBuilder } from "./ConditionBuilder";
import { ActionBuilder, type BuilderAction } from "./ActionBuilder";
import { executeWorkflowViaApi } from "../_test-run";
import {
  isErrorEnvelope,
  type ActionConfig,
  type CreateWorkflowInput,
  type Workflow,
  type WorkflowResult,
} from "../_types";

const textareaClasses =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30";

function StepHeader({
  n,
  title,
  hint,
}: {
  n: number;
  title: string;
  hint: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold">
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background">
          {n}
        </span>
        {title}
      </h2>
      <p className="mt-1 pl-8 text-xs text-ink-muted">{hint}</p>
    </div>
  );
}

/**
 * Convert stored ActionConfig[] into the builder's editable shape. Params are
 * read as free-form records; the save path re-validates with
 * CreateWorkflowSchema, so nothing unvalidated can reach the server.
 */
function toBuilderActions(actions: ActionConfig[]): BuilderAction[] {
  return actions.map((action) => ({
    type: action.type,
    params: { ...((action.params ?? {}) as Record<string, unknown>) },
    key: action.key,
  }));
}

/**
 * WHEN / IF / THEN workflow builder (client).
 *
 * Client-side validation mirrors the server zod schemas directly — it
 * imports CreateWorkflowSchema from @/lib/workflows/schema (no duplicated
 * schemas); the server remains the source of truth on save.
 *
 * - new: onSave = createWorkflowAction; after save → redirect to the detail page
 * - edit: onSave = updateWorkflowAction.bind(null, id); after save → back to detail
 */
export function WorkflowBuilder({
  initial,
  onSave,
  submitLabel,
}: {
  initial?: Workflow;
  onSave: (input: CreateWorkflowInput) => Promise<WorkflowResult<Workflow>>;
  submitLabel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState<TriggerConfig>(
    initial?.trigger ?? { type: "deal.stage_changed", entityType: "deal" },
  );
  const [conditions, setConditions] = useState<ConditionNode[]>(
    initial?.conditions ?? [],
  );
  const [actions, setActions] = useState<BuilderAction[]>(() =>
    toBuilderActions(initial?.actions ?? []),
  );
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const triggerType = String(trigger.type);

  function applyZodErrors(
    issues: { path: readonly PropertyKey[]; message: string }[],
  ) {
    const next: Record<string, string> = {};
    for (const issue of issues) {
      const top = typeof issue.path[0] === "string" ? issue.path[0] : "form";
      if (next[top] === undefined) next[top] = issue.message;
    }
    setFieldErrors(next);
    const first = issues[0];
    return first ? first.message : "Please fix the highlighted fields.";
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const payload = {
      name: name.trim(),
      description: description.trim() === "" ? undefined : description.trim(),
      trigger,
      conditions,
      // BuilderAction → ActionConfig: the zod parse below re-validates every
      // action against the server schema, so this cast is safe at the
      // boundary — unvalidated shapes cannot be submitted.
      actions: actions.map((a) => ({
        type: a.type,
        params: a.params,
        key: a.key,
      })) as ActionConfig[],
    };

    const parsed = CreateWorkflowSchema.safeParse(payload);
    if (!parsed.success) {
      const message = applyZodErrors(parsed.error.issues);
      toast.error("Could not save", { description: message });
      return;
    }

    setPending(true);
    try {
      const result = await onSave(parsed.data);
      if (isErrorEnvelope(result)) {
        setFormError(result.error.message);
        toast.error("Could not save", { description: result.error.message });
        return;
      }
      toast.success(initial ? "Workflow updated" : "Workflow created", {
        description: initial
          ? undefined
          : "It starts as a draft — activate it from its page when ready.",
      });
      router.push(`/workflows/${result.id}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      setFormError(message);
      toast.error("Could not save", { description: message });
    } finally {
      setPending(false);
    }
  }

  async function handleTestRun() {
    if (!initial?.id) return;
    setTesting(true);
    try {
      const outcome = await executeWorkflowViaApi(initial.id);
      if (outcome.ok) {
        toast.success("Test run accepted", {
          description:
            `Execution ${outcome.executionId ?? ""} ${outcome.executionStatus ?? ""}`.trim(),
        });
      } else {
        toast.error("Test run failed", {
          description:
            outcome.error ??
            (outcome.status === 400
              ? "Only ACTIVE workflows can run — activate this workflow first."
              : `HTTP ${outcome.status}`),
        });
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-8">
      {/* Identity */}
      <section className="rounded-lg border border-line bg-card p-5">
        <div className="grid gap-4">
          <div>
            <FieldLabel htmlFor="wf-name">Workflow name *</FieldLabel>
            <Input
              id="wf-name"
              type="text"
              value={name}
              maxLength={200}
              placeholder="e.g. Won deal → onboarding"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldErrors.name !== undefined}
              aria-describedby={fieldErrors.name ? "wf-name-error" : undefined}
            />
            {fieldErrors.name && (
              <div id="wf-name-error">
                <FieldError message={fieldErrors.name} />
              </div>
            )}
          </div>
          <div>
            <FieldLabel htmlFor="wf-description">Description</FieldLabel>
            <textarea
              id="wf-description"
              rows={2}
              className={textareaClasses}
              value={description}
              maxLength={4000}
              placeholder="What this automation does, in one or two lines."
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* 1 — WHEN */}
      <section className="rounded-lg border border-line bg-card p-5">
        <StepHeader
          n={1}
          title="WHEN — trigger"
          hint="The event that wakes this workflow. Filter inputs narrow it further (matched with equals semantics against the event)."
        />
        <TriggerPicker
          value={trigger}
          onChange={setTrigger}
          error={fieldErrors.trigger}
        />
      </section>

      {/* 2 — IF */}
      <section className="rounded-lg border border-line bg-card p-5">
        <StepHeader
          n={2}
          title="IF — conditions"
          hint={`Optional. Nested AND/OR groups over deal, task, project, and event fields — capped at ${50} conditions and ${5} nesting levels.`}
        />
        <ConditionBuilder
          nodes={conditions}
          onChange={setConditions}
          error={fieldErrors.conditions}
        />
      </section>

      {/* 3 — THEN */}
      <section className="rounded-lg border border-line bg-card p-5">
        <StepHeader
          n={3}
          title="THEN — actions"
          hint="Run in order. Use {{path}} templates to reuse values from the triggering event."
        />
        <ActionBuilder
          actions={actions}
          onChange={setActions}
          triggerType={triggerType}
          error={fieldErrors.actions}
        />
      </section>

      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
        >
          <p className="font-medium">Could not save</p>
          <p className="mt-1">{formError}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        {initial?.id && initial.status === "ACTIVE" && (
          <Button
            type="button"
            variant="outline"
            disabled={testing}
            onClick={handleTestRun}
          >
            {testing ? "Running…" : "Test run"}
          </Button>
        )}
        <LinkButton href="/workflows" variant="outline" size="sm">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}
