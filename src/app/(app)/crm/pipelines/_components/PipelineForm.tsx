'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isErrorEnvelope, type CrmResult, type Pipeline } from '@/components/crm/types';
import { createPipelineAction, updatePipelineAction } from '../_actions';

const FormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(1000),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    }),
  isDefault: z.boolean(),
});

/**
 * Create / rename a pipeline. On create we land on the new board; on rename we
 * refresh in place.
 */
export function PipelineDialog({
  open,
  onOpenChange,
  pipeline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline?: Pipeline;
}) {
  const router = useRouter();
  const editing = !!pipeline;
  const [name, setName] = useState(pipeline?.name ?? '');
  const [description, setDescription] = useState(pipeline?.description ?? '');
  const [isDefault, setIsDefault] = useState(pipeline?.isDefault ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const parsed = FormSchema.safeParse({ name, description, isDefault });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    setPending(true);
    try {
      const result: CrmResult<Pipeline & { stages: unknown[] }> = editing
        ? await updatePipelineAction(pipeline.id, parsed.data)
        : await createPipelineAction(parsed.data);
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      if (editing) {
        router.refresh();
      } else {
        router.push(`/crm/pipelines/${result.id}`);
      }
    } catch {
      setError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Rename pipeline' : 'New pipeline'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Rename the pipeline or change its default status.'
              : 'Pipelines group deal stages. You can add stages right after creating it.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pipeline-name">Name *</Label>
            <Input
              id="pipeline-name"
              value={name}
              maxLength={1000}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Enterprise sales"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pipeline-description">Description</Label>
            <Input
              id="pipeline-description"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4"
            />
            Default pipeline
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create pipeline'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
