'use client';

import { useRouter } from 'next/navigation';
import { TaskForm, type TaskFormInput } from './TaskForm';
import type { PersonOption, WorkResult, WorkTask } from '../_types';

/** Task edit form: refreshes the detail page after a successful save. */
export function EditTaskForm({
  task,
  assignees,
  canAssign,
  onSave,
}: {
  task: WorkTask;
  assignees: PersonOption[];
  canAssign: boolean;
  onSave: (input: TaskFormInput) => Promise<WorkResult<WorkTask>>;
}) {
  const router = useRouter();
  return (
    <TaskForm
      initial={task}
      assignees={assignees}
      canAssign={canAssign}
      onSave={onSave}
      onSaved={() => router.refresh()}
      submitLabel="Save changes"
    />
  );
}
