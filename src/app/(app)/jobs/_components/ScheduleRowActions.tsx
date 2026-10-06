'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ScheduleRow } from '../_jobs';
import { ScheduleForm } from './ScheduleForm';

/**
 * ScheduleRowActions — per-schedule edit / activate-pause / delete.
 *
 * Mutations hit the REST endpoints (contract §4.2) so status codes drive the
 * toasts. Buttons are hidden unless the server decided the user holds the
 * matching permission: canEdit ← jobs.create, canDelete ← jobs.delete.
 */
export function ScheduleRowActions({
  schedule,
  workflows,
  canEdit,
  canDelete,
}: {
  schedule: ScheduleRow;
  workflows: { id: string; name: string }[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!canEdit && !canDelete) return null;

  async function toggleActive() {
    setPending(true);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: !schedule.isActive }),
      });
      if (!res.ok) {
        if (res.status === 403 || res.status === 404)
          toast.error('Access changed — you can no longer manage schedules.');
        else toast.error(`Update failed (HTTP ${res.status}).`);
        return;
      }
      toast.success(schedule.isActive ? 'Schedule paused.' : 'Schedule activated.');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    setPending(true);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        if (res.status === 403 || res.status === 404)
          toast.error('Access changed — you can no longer delete schedules.');
        else toast.error(`Delete failed (HTTP ${res.status}).`);
        return;
      }
      toast.success('Schedule deleted.');
      setDeleteOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Toaster />
      {canEdit && (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={toggleActive}>
            {schedule.isActive ? 'Pause' : 'Activate'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Edit schedule</DialogTitle>
                <DialogDescription>Changes apply from the next scheduled run.</DialogDescription>
              </DialogHeader>
              <ScheduleForm
                workflows={workflows}
                schedule={schedule}
                onDone={() => setEditOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </>
      )}
      {canDelete && (
        <>
          <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete schedule?</DialogTitle>
                <DialogDescription>
                  “{schedule.name}” will stop firing. Jobs it already enqueued keep running. This
                  cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
                  {pending ? 'Deleting…' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
