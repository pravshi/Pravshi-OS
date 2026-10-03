'use client';

import { useRouter } from 'next/navigation';
import { ProjectForm, type ProjectFormInput } from './ProjectForm';
import type { Project, WorkResult } from '../_types';

/** New-project page body: the form, then navigate to the created project. */
export function CreateProjectForm({
  onSave,
}: {
  onSave: (input: ProjectFormInput) => Promise<WorkResult<Project>>;
}) {
  const router = useRouter();
  return (
    <ProjectForm
      onSave={onSave}
      onSaved={(project) => router.push(`/work/projects/${project.id}`)}
      submitLabel="Create project"
    />
  );
}
