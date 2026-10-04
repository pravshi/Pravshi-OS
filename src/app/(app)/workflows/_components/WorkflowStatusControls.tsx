'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/crm/link-button';
import type { WorkflowStatus } from '../_types';

/**
 * WorkflowStatusControls — Activate / Pause / Edit for a workflow definition.
 *
 * Calls POST /api/workflows/[id]/activate (or /pause) directly so the UI can
 * distinguish 400 (illegal transition, e.g. deferred trigger type) from
 * 403/404 (lost access) in its toasts. Permission-gated by the held set:
 * rendering is hidden, and the API re-authorizes every call.
 */
export function WorkflowStatusControls({
  workflowId,
  status,
  canActivate,
  canEdit,
}: {
  workflowId: string;
  status: WorkflowStatus;
  canActivate: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function transition(to: 'activate' | 'pause') {
    setPending(true);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/${to}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        // 400 bodies are { error: 'INVALID_REQUEST', message: '<specific>' } —
        // surface the specific message string, not a nested error object.
        const message =
          body &&
          typeof body === 'object' &&
          'message' in body &&
          typeof (body as { message: unknown }).message === 'string'
            ? String((body as { message: string }).message)
            : `Could not ${to} this workflow.`;
        if (res.status === 400) toast.error(message);
        else if (res.status === 403 || res.status === 404)
          toast.error('Access changed — you can no longer modify this workflow.');
        else toast.error(message);
        return;
      }
      toast.success(to === 'activate' ? 'Workflow activated.' : 'Workflow paused.');
      router.refresh();
    } catch {
      toast.error('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toaster />
      {canActivate && status === 'DRAFT' && (
        <Button size="sm" disabled={pending} onClick={() => transition('activate')}>
          {pending ? 'Activating…' : 'Activate'}
        </Button>
      )}
      {canActivate && status === 'PAUSED' && (
        <Button size="sm" disabled={pending} onClick={() => transition('activate')}>
          {pending ? 'Activating…' : 'Resume'}
        </Button>
      )}
      {canActivate && status === 'ACTIVE' && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => transition('pause')}>
          {pending ? 'Pausing…' : 'Pause'}
        </Button>
      )}
      {canEdit && status !== 'ARCHIVED' && (
        <LinkButton href={`/workflows/${workflowId}/edit`}>Edit</LinkButton>
      )}
    </div>
  );
}
