'use client';

import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel, FieldError } from '@/components/crm/pickers';
import { isErrorEnvelope, type Project, type WorkResult } from '../_types';

export interface ProjectFormInput {
  name: string;
  description: string | null;
}

const ProjectFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  description: z.string().trim().max(4000, 'Description is too long').optional(),
});

const textareaClasses =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30';

/**
 * Project create/edit form. Archive/unarchive is a separate action on the
 * project detail page — not a form field. The server action arrives as
 * `onSave` (bound with `.bind(null, id)` for edits — never an inline closure).
 */
export function ProjectForm({
  initial,
  onSave,
  onSaved,
  submitLabel,
}: {
  initial?: Project;
  onSave: (input: ProjectFormInput) => Promise<WorkResult<Project>>;
  onSaved?: (project: Project) => void;
  submitLabel?: string;
}) {
  const isEdit = Boolean(initial);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [values, setValues] = useState({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
  });

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const parsed = ProjectFormSchema.safeParse(values);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.');
          if (path && !errors[path]) errors[path] = issue.message;
        }
        setFieldErrors(errors);
        setFormError('Please fix the highlighted fields.');
        return;
      }
      const result = await onSave({
        name: parsed.data.name.trim(),
        description: parsed.data.description?.trim() ? parsed.data.description.trim() : null,
      });
      if (isErrorEnvelope(result)) {
        setFormError(result.error.message);
      } else {
        onSaved?.(result);
      }
    } catch {
      setFormError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="project-name">Name</FieldLabel>
        <Input
          id="project-name"
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Website redesign"
          maxLength={200}
          disabled={pending}
          aria-invalid={Boolean(fieldErrors.name)}
        />
        <FieldError message={fieldErrors.name} />
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor="project-description">Description</FieldLabel>
        <textarea
          id="project-description"
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="What is this project about?"
          maxLength={4000}
          rows={4}
          disabled={pending}
          className={textareaClasses}
          aria-invalid={Boolean(fieldErrors.description)}
        />
        <FieldError message={fieldErrors.description} />
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : (submitLabel ?? (isEdit ? 'Save changes' : 'Create project'))}
        </Button>
      </div>
    </form>
  );
}
