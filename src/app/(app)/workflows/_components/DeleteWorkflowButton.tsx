"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * DeleteWorkflowButton — danger-zone soft delete for a workflow definition.
 *
 * Calls DELETE /api/workflows/[id] directly (200 { ok:true } on success;
 * the row is soft-deleted via crm_soft_delete). The shadcn confirm dialog
 * follows the DeleteDialog pattern; on success we navigate to /workflows.
 *
 * Status lifecycle note: there is no archive endpoint (§14). ARCHIVED is a
 * stored status value, but the only supported danger-zone transition from
 * the UI is soft delete; DRAFT → ACTIVE → PAUSED is the live lifecycle.
 */
export function DeleteWorkflowButton({
  workflowId,
  workflowName,
}: {
  workflowId: string;
  workflowName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        if (res.status === 403 || res.status === 404)
          setError("Access changed — you can no longer delete this workflow.");
        else setError(`Delete failed (HTTP ${res.status}). Please try again.`);
        return;
      }
      setOpen(false);
      router.push("/workflows");
      router.refresh();
    } catch {
      setError("The delete request failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete workflow
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete workflow?</DialogTitle>
            <DialogDescription>
              “{workflowName}” will be soft-deleted: it disappears from lists
              and stops matching events, but stays in the audit trail and can be
              recovered by an administrator. This cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirm} disabled={pending}>
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
