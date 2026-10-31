'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Hides an edit form behind a button until the user asks for it. */
export function EditableSection({
  buttonLabel,
  children,
}: {
  buttonLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
    );
  }
  return <div className="space-y-4">{children}</div>;
}
