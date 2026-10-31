'use client';

import { useRouter } from 'next/navigation';
import { ProjectForm, type ProjectFormInput } from './ProjectForm';
import type { Project, WorkResult } from '../_types';

/** Project edit form: refreshes the detail page after a successful save. */
export function EditProjectForm({
  project,
  onSave,
}: {
  project: Project;
  onSave: (input: ProjectFormInput) => Promise<WorkResult<Project>>;
}) {
  const router = useRouter();
  return (
    <ProjectForm
      initial={project}
      onSave={onSave}
      onSaved={() => router.refresh()}
      submitLabel="Save changes"
    />
  );
}
