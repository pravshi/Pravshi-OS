'use client';

import { Button } from '@/components/ui/button';

/**
 * The outcome of an email-only setup-link delivery — never the link itself (founder policy
 * 2026-10-29). Used for organization first administrators and platform administrators alike.
 */
export type DeliveryShown = {
  title: string;
  emailed: boolean;
  recipient: string;
  expiresAt: string;
};

export function DeliveryNotice({
  shown,
  onDismiss,
}: {
  shown: DeliveryShown;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className={`rounded-lg border p-5 ${shown.emailed ? 'border-line bg-white' : 'border-amber-300 bg-amber-50 text-amber-950'}`}
    >
      <p className="font-medium">{shown.title}</p>
      <p className="mt-1 text-sm">
        {shown.emailed
          ? `The setup link was emailed to ${shown.recipient}. It works once and expires ${new Date(shown.expiresAt).toLocaleString()}. Links are never shown in the console.`
          : `The email to ${shown.recipient} was not accepted by the mail service. The link was not delivered; re-issue it to send a new one.`}
      </p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onDismiss}>
        Done
      </Button>
    </div>
  );
}
