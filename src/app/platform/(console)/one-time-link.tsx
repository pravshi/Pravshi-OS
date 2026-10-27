'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A setup link, shown once. It is not stored anywhere the console can show it again: if it is
 * lost, re-issue it (the old one stops working).
 */
export function OneTimeLink({
  title,
  link,
  expiresAt,
  onDismiss,
}: {
  title: string;
  link: string;
  expiresAt: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-amber-950"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm">
        Send this link to the person by a channel you trust. It is shown only now, works once, and
        expires {new Date(expiresAt).toLocaleString()}.
      </p>
      <code className="mt-3 block break-all rounded bg-white px-3 py-2 font-mono text-xs">
        {link}
      </code>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
