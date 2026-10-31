'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Export buttons for /admin/audit-logs. Exports whatever the page is currently
 * filtered to (action/result come from the page's search params). The download
 * goes through fetch so the truncation headers can be read: when the export was
 * capped, a note tells the reader to narrow the filters for the rest.
 */
export function ExportButtons({ action, result }: { action?: string; result?: string }) {
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onExport(format: 'csv' | 'json') {
    setBusy(format);
    setError(null);
    setTruncated(false);
    try {
      const params = new URLSearchParams({ format });
      if (action) params.set('action', action);
      if (result) params.set('result', result);
      const res = await fetch(`/api/admin/audit-logs/export?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as { message?: string } | null)?.message ?? `Export failed (${res.status}).`,
        );
      }
      setTruncated(res.headers.get('X-Export-Truncated') === 'true');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      a.download = match?.[1] ?? `audit-logs.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy !== null} onClick={() => onExport('csv')}>
          {busy === 'csv' ? 'Exporting…' : 'Export CSV'}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => onExport('json')}>
          {busy === 'json' ? 'Exporting…' : 'Export JSON'}
        </Button>
      </div>
      {truncated && (
        <p className="text-sm text-amber-700">
          Export capped at 10,000 rows — narrow the filters to export the rest.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
