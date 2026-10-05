import Link from "next/link";
import { requirePagePermission } from "@/lib/authz/page";
import { createWorkflowAction } from "../_actions";
import { WORKFLOW_PERMISSIONS } from "../_permissions";
import { WorkflowBuilder } from "../_components/WorkflowBuilder";

/** /workflows/new — build a workflow definition (always starts as DRAFT). */
export default async function NewWorkflowPage() {
  await requirePagePermission(WORKFLOW_PERMISSIONS.workflows.create);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/workflows"
          className="text-sm text-ink-muted hover:text-foreground"
        >
          ← All automations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          New workflow
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Define WHEN it runs, IF extra conditions hold, and THEN which actions
          fire. It starts as a draft — you activate it from its page once it is
          ready.
        </p>
      </div>
      <WorkflowBuilder
        onSave={createWorkflowAction}
        submitLabel="Create workflow"
      />
    </div>
  );
}
