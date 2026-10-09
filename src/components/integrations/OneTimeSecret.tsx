'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { RevealedSecret } from './integrations-client';

/**
 * OneTimeSecret — the single display of a secret that exists exactly
 * once (Phase 10, Wave G; contract §4.3/§4.4): a subscription signing
 * secret at create/rotate, an inbound endpoint URL at issue/rotate.
 *
 * The plaintext lives only in the parent component's state and is
 * dropped on dismiss (integrations-client's dismissSecret). It is never
 * written to storage, never put in a URL, and this component renders it
 * in a read-only mono block with a copy affordance — the admin's one
 * chance to take it away.
 */
export function OneTimeSecret({
  revealed,
  onDismiss,
}: {
  revealed: RevealedSecret;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      toast.success('Copied — store it somewhere safe.');
    } catch {
      toast.error('Copy failed — select the value and copy it manually.');
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{revealed.label}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Shown once — it is stored only as a hash or encrypted envelope and cannot be displayed
            again. {revealed.hint}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-xs whitespace-nowrap">
              {revealed.secret}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              I’ve saved it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
