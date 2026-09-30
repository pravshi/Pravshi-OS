'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isErrorEnvelope, type CrmResult, type PipelineStage } from '@/components/crm/types';
import { createStageAction, updateStageAction } from '../_actions';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const StageInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  probability: z.number().int().min(0).max(100),
  color: z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim();
      if (!t) return null;
      return HEX_RE.test(t) ? t : 'INVALID';
    }),
  terminal: z.enum(['open', 'won', 'lost']),
});

type Terminal = 'open' | 'won' | 'lost';

function terminalOf(stage: PipelineStage): Terminal {
  if (stage.isWon) return 'won';
  if (stage.isLost) return 'lost';
  return 'open';
}

function toPayload(values: { name: string; probability: number; color: string | null; terminal: Terminal }) {
  return {
    name: values.name,
    probability: values.probability,
    color: values.color,
    isWon: values.terminal === 'won',
    isLost: values.terminal === 'lost',
  };
}

/**
 * One stage row: inline rename, probability slider, hex color, won/lost
 * toggles (mutually exclusive), and position up/down. No delete control —
 * stages with history cannot be deleted by design.
 */
export function StageRowEditor({
  stage,
  isFirst,
  isLast,
}: {
  stage: PipelineStage;
  isFirst: boolean;
  isLast: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(stage.name);
  const [probability, setProbability] = useState(Math.round(Number(stage.probability)));
  const [color, setColor] = useState(stage.color ?? '');
  const [terminal, setTerminal] = useState<Terminal>(terminalOf(stage));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    name !== stage.name ||
    probability !== Math.round(Number(stage.probability)) ||
    (color || null) !== stage.color ||
    terminal !== terminalOf(stage);

  async function save(patch: Record<string, unknown>) {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const result: CrmResult<PipelineStage> = await updateStageAction(stage.id, patch);
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  async function saveForm() {
    const parsed = StageInputSchema.safeParse({ name, probability, color, terminal });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    if (parsed.data.color === 'INVALID') {
      setError('Color must be a #RRGGBB hex value.');
      return;
    }
    await save(toPayload({ ...parsed.data, color: parsed.data.color }));
  }

  async function move(direction: -1 | 1) {
    await save({ position: stage.position + direction });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 rounded-full border border-line"
          style={{ backgroundColor: stage.color ?? '#94a3b8' }}
        />
        <div className="min-w-48 flex-1">
          <Label htmlFor={`stage-name-${stage.id}`} className="sr-only">
            Stage name
          </Label>
          <Input
            id={`stage-name-${stage.id}`}
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1" aria-label="Reorder stage">
          <Button variant="outline" size="sm" disabled={isFirst || pending} onClick={() => void move(-1)} title="Move earlier">
            ↑
          </Button>
          <Button variant="outline" size="sm" disabled={isLast || pending} onClick={() => void move(1)} title="Move later">
            ↓
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`stage-prob-${stage.id}`}>
            Win probability: <span className="font-semibold">{probability}%</span>
          </Label>
          <input
            id={`stage-prob-${stage.id}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={probability}
            onChange={(e) => setProbability(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`stage-color-${stage.id}`}>Color (#RRGGBB)</Label>
          <div className="flex items-center gap-2">
            <input
              id={`stage-color-${stage.id}`}
              type="color"
              value={HEX_RE.test(color) ? color : '#94a3b8'}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border border-line bg-white p-0.5"
              aria-label="Pick stage color"
            />
            <Input
              value={color}
              maxLength={7}
              placeholder="#94a3b8"
              onChange={(e) => setColor(e.target.value)}
              aria-label="Stage color hex"
            />
          </div>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Terminal state</legend>
          <div className="flex gap-2 pt-1">
            {(['open', 'won', 'lost'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm capitalize">
                <input
                  type="radio"
                  name={`terminal-${stage.id}`}
                  checked={terminal === t}
                  onChange={() => setTerminal(t)}
                  className="h-4 w-4"
                />
                {t === 'open' ? 'Open' : t}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={!dirty || pending} onClick={() => void saveForm()}>
          {pending ? 'Saving…' : 'Save stage'}
        </Button>
        {saved && !dirty && <span className="text-xs text-ink-muted">Saved.</span>}
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/** Add a stage to the end of the pipeline (position auto-assigned). */
export function AddStageForm({ pipelineId }: { pipelineId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [probability, setProbability] = useState(0);
  const [color, setColor] = useState('');
  const [terminal, setTerminal] = useState<Terminal>('open');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const parsed = StageInputSchema.safeParse({ name, probability, color, terminal });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    if (parsed.data.color === 'INVALID') {
      setError('Color must be a #RRGGBB hex value.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result: CrmResult<PipelineStage> = await createStageAction(
        pipelineId,
        toPayload({ ...parsed.data, color: parsed.data.color }),
      );
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
        return;
      }
      setName('');
      setProbability(0);
      setColor('');
      setTerminal('open');
      router.refresh();
    } catch {
      setError('The request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-line p-4">
      <h3 className="text-sm font-semibold">Add stage</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="new-stage-name">Name *</Label>
          <Input
            id="new-stage-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Discovery"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-stage-prob">
            Win probability: <span className="font-semibold">{probability}%</span>
          </Label>
          <input
            id="new-stage-prob"
            type="range"
            min={0}
            max={100}
            step={1}
            value={probability}
            onChange={(e) => setProbability(Number(e.target.value))}
            className="w-full pt-2"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-stage-color">Color (#RRGGBB)</Label>
          <Input
            id="new-stage-color"
            value={color}
            maxLength={7}
            placeholder="#94a3b8"
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Terminal state</legend>
          <div className="flex gap-2 pt-2">
            {(['open', 'won', 'lost'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm capitalize">
                <input
                  type="radio"
                  name="new-terminal"
                  checked={terminal === t}
                  onChange={() => setTerminal(t)}
                  className="h-4 w-4"
                />
                {t === 'open' ? 'Open' : t}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={pending || !name.trim()} onClick={() => void submit()}>
          {pending ? 'Adding…' : 'Add stage'}
        </Button>
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}
