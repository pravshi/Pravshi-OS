"use client";

import { useEffect, useState } from "react";
import { Check, Circle, Minus, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/components/crm/format";
import {
  ExecutionStatusBadge,
  EXECUTION_STATUS_LABELS,
} from "./WorkflowStatusBadge";
import { formatDurationMs } from "./execution-format";
import type {
  WorkflowExecutionDetail,
  WorkflowExecutionStep,
} from "@/lib/workflows/service";

/**
 * ExecutionDetail — one run with its per-step results.
 *
 * Loads GET /api/workflow-executions/[id] (execution + steps[]). Each step
 * shows ✓/✗, its duration, and the sanitized error code/message. Result
 * payloads render as scalar id/title entries only — raw payloads that could
 * carry PII are never dumped.
 */

const ACTION_LABELS: Record<string, string> = {
  create_task: "Create task",
  create_project: "Create project",
  update_deal: "Update deal",
  update_task: "Update task",
  assign_task: "Assign task",
  link_deal_project: "Link project to deal",
};

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "SUCCEEDED":
      return (
        <Check
          className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
          aria-label="succeeded"
        />
      );
    case "FAILED":
      return (
        <XCircle
          className="h-4 w-4 text-red-600 dark:text-red-400"
          aria-label="failed"
        />
      );
    case "SKIPPED":
      return (
        <Minus className="h-4 w-4 text-neutral-400" aria-label="skipped" />
      );
    default:
      return (
        <Circle
          className="h-4 w-4 text-neutral-400"
          aria-label={status.toLowerCase()}
        />
      );
  }
}

/**
 * Render only scalar entries (ids, titles, counts) from a step's result —
 * nested objects/arrays are raw payloads and stay hidden.
 */
function ResultScalars({ result }: { result: Record<string, unknown> | null }) {
  if (!result) return null;
  const entries = Object.entries(result).filter(
    ([, v]) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1.5 space-y-0.5">
      {entries.slice(0, 8).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-xs">
          <dt className="shrink-0 text-ink-muted">{k}:</dt>
          <dd className="truncate font-mono">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function StepRow({ step }: { step: WorkflowExecutionStep }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5">
      <span className="mt-0.5">
        <StepIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-ink-muted">
            #{step.stepIndex + 1}
          </span>
          <span className="text-sm font-medium">
            {ACTION_LABELS[step.actionType] ?? step.actionType}
          </span>
          <ExecutionStatusBadge status={step.status} />
          <span className="ml-auto text-xs text-ink-muted">
            {formatDurationMs(step.durationMs)}
          </span>
        </div>
        {step.errorCode && (
          <p className="mt-1 text-xs">
            <Badge variant="destructive" className="mr-1.5 font-mono">
              {step.errorCode}
            </Badge>
            <span className="text-red-700 dark:text-red-300">
              {step.errorMessage ?? ""}
            </span>
          </p>
        )}
        <ResultScalars result={step.result} />
      </div>
    </li>
  );
}

export function ExecutionDetail({ executionId }: { executionId: string }) {
  const [execution, setExecution] = useState<WorkflowExecutionDetail | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExecution(null);
    setError(null);
    fetch(`/api/workflow-executions/${encodeURIComponent(executionId)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(`Could not load this run (HTTP ${res.status}).`);
        return (await res.json()) as WorkflowExecutionDetail;
      })
      .then((data) => {
        if (!cancelled) setExecution(data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Could not load this run.");
      });
    return () => {
      cancelled = true;
    };
  }, [executionId]);

  if (error)
    return (
      <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!execution) {
    return (
      <div className="space-y-2 py-2" aria-label="Loading run details">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-muted">Status</dt>
          <dd className="mt-0.5">
            <ExecutionStatusBadge status={execution.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Trigger</dt>
          <dd className="mt-0.5 font-mono text-xs">{execution.triggerType}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Started</dt>
          <dd className="mt-0.5">{formatDateTime(execution.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Duration</dt>
          <dd className="mt-0.5">{formatDurationMs(execution.durationMs)}</dd>
        </div>
      </dl>
      {execution.errorCode && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          <span className="font-mono font-semibold">{execution.errorCode}</span>
          {execution.errorMessage ? ` — ${execution.errorMessage}` : ""}
        </p>
      )}
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-widest text-ink-muted uppercase">
          Steps ({execution.steps.length})
        </h3>
        {execution.steps.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No steps recorded — the run ended before any action executed.
          </p>
        ) : (
          <ul className="space-y-2">
            {execution.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        Ran as workflow version {execution.workflowVersion} ·{" "}
        {EXECUTION_STATUS_LABELS[execution.status] ?? execution.status}
      </p>
    </div>
  );
}
