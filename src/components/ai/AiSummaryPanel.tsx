'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AiCapabilityId, AiTargetEntityType } from '@/lib/ai/types';
import { AiApiError, requestAiSummary, type AiAssistResponse } from './ai-client';

/**
 * AiSummaryPanel — the Phase 9 AI assistance surface (Workstream G, contract §9).
 *
 * Rendered by the six record detail pages below their header, with
 * `capability`, `entityType`, `entityId` and the server-computed `canUseAi`
 * display flag as props. It calls POST /api/ai/assist through ai-client.ts.
 * Hiding the panel (canUseAi false) is display gating only — the backend
 * enforces `ai.use` and every record permission independently.
 *
 * States (all required by §9): idle → loading (Skeleton lines) → success
 * (headline; Facts; Missing information; Suggestions under a distinct
 * "AI suggestions" Badge label; sources as muted links; provider/model as
 * small muted text) → not-configured (calm message, no button) → limited
 * (message + retry hint, button disabled while the server-supplied
 * retryAfterSeconds counts down) → error (safe message + Retry) →
 * forbidden (access-denied message).
 *
 * No general-assistance UI exists in V1 (§9 decision): this panel only ever
 * sends a capability + target, never a free-text question.
 */

export interface AiSummaryPanelProps {
  readonly capability: AiCapabilityId;
  readonly entityType: AiTargetEntityType;
  readonly entityId: string;
  /** Server-computed display flag (see can-use-ai.ts). Not authorization. */
  readonly canUseAi: boolean;
}

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'success'; readonly result: AiAssistResponse }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error'; readonly message: string };

const SOURCE_HREF: Record<AiTargetEntityType, (id: string) => string> = {
  company: (id) => `/crm/companies/${id}`,
  contact: (id) => `/crm/contacts/${id}`,
  deal: (id) => `/crm/deals/${id}`,
  activity: (id) => `/crm/activities/${id}`,
  project: (id) => `/work/projects/${id}`,
  task: (id) => `/work/tasks/${id}`,
};

export function AiSummaryPanel({
  capability,
  entityType,
  entityId,
  canUseAi,
}: AiSummaryPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight request when the panel unmounts or the record changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: 'idle' });
    setSecondsLeft(0);
  }, [capability, entityType, entityId]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Limited-state countdown: the retry button stays disabled until the
  // server-supplied hint elapses (§9).
  useEffect(() => {
    if (state.kind !== 'limited' || secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [state.kind, secondsLeft]);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const result = await requestAiSummary(
        { capability, target: { entityType, entityId } },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setState({ kind: 'success', result });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof AiApiError) {
        switch (error.code) {
          case 'AI_NOT_CONFIGURED':
            setState({ kind: 'not_configured' });
            return;
          case 'AI_LIMITED':
            setSecondsLeft(error.retryAfterSeconds ?? 0);
            setState({ kind: 'limited', retryAfterSeconds: error.retryAfterSeconds });
            return;
          case 'FORBIDDEN':
          case 'UNAUTHORIZED':
            setState({ kind: 'forbidden' });
            return;
          default:
            setState({ kind: 'error', message: error.message });
            return;
        }
      }
      setState({
        kind: 'error',
        message: 'AI assistance is temporarily unavailable. Please try again.',
      });
    }
  }, [capability, entityType, entityId]);

  if (!canUseAi) return null;

  const busy = state.kind === 'loading';
  const retryDisabled = state.kind === 'limited' && secondsLeft > 0;

  return (
    <Card aria-busy={busy}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden />
          AI summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.kind === 'idle' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Generate a summary of this record from the information you can access.
            </p>
            <Button type="button" onClick={run}>
              Summarize
            </Button>
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="space-y-2" aria-label="Generating summary">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        )}

        {state.kind === 'success' && <SummaryView result={state.result} onRefresh={run} />}

        {state.kind === 'not_configured' && (
          <p className="text-sm text-ink-muted">AI isn&apos;t configured for this workspace yet.</p>
        )}

        {state.kind === 'limited' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              AI usage limit reached for this workspace.
              {state.retryAfterSeconds !== null &&
                ` You can try again in about ${state.retryAfterSeconds} seconds.`}
            </p>
            <Button type="button" variant="outline" onClick={run} disabled={retryDisabled}>
              <RefreshCw aria-hidden />
              {retryDisabled ? `Try again in ${secondsLeft}s` : 'Try again'}
            </Button>
          </div>
        )}

        {state.kind === 'forbidden' && (
          <p className="text-sm text-ink-muted">
            You don&apos;t have access to AI assistance for this record.
          </p>
        )}

        {state.kind === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">{state.message}</p>
            <Button type="button" variant="outline" onClick={run}>
              <RefreshCw aria-hidden />
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryView({ result, onRefresh }: { result: AiAssistResponse; onRefresh: () => void }) {
  const { summary, sources, usage } = result;
  return (
    <div className="space-y-4">
      <p className="font-medium">{summary.headline}</p>

      {summary.facts.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Facts</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {summary.facts.map((fact, i) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
        </section>
      )}

      {summary.missingInformation.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Missing information</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
            {summary.missingInformation.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {summary.suggestions.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            Suggestions
            <Badge variant="secondary">AI suggestions</Badge>
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {summary.suggestions.map((suggestion, i) => (
              <li key={i}>{suggestion}</li>
            ))}
          </ul>
        </section>
      )}

      {sources.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Sources</h3>
          <ul className="space-y-1 text-sm">
            {sources.map((source) => (
              <li key={`${source.entityType}:${source.entityId}`}>
                <Link
                  href={SOURCE_HREF[source.entityType](source.entityId)}
                  className="text-ink-muted hover:text-foreground"
                >
                  {source.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-ink-muted">
          {usage.provider} · {usage.model}
          {usage.totalTokens !== null ? ` · ${usage.totalTokens} tokens` : ''}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw aria-hidden />
          Refresh
        </Button>
      </div>
    </div>
  );
}
