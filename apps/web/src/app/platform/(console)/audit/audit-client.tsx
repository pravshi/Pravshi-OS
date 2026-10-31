'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { platformApi } from '../platform-api';

interface AuditRow {
  id: string;
  occurredAt: string;
  actorType: string;
  actorAdminId: string | null;
  actorEmail: string | null;
  action: string;
  result: string;
  reasonCode: string | null;
  targetOrgId: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: unknown;
}

type Cursor = { beforeAt: string; beforeId: string } | null;

const PAGE = 50;

export function AuditClient() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<Cursor>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor: Cursor) => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) {
      q.set('beforeAt', cursor.beforeAt);
      q.set('beforeId', cursor.beforeId);
    }
    const r = await platformApi<{ rows: AuditRow[]; next: Cursor }>(`/audit?${q.toString()}`);
    setLoading(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setRows((prev) => (cursor ? [...prev, ...r.data.rows] : r.data.rows));
    setNext(r.data.next);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform audit</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every platform change, and every refused or failed attempt. Append-only.
        </p>
      </div>
      <section className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-ink-muted">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Result</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2 whitespace-nowrap">
                  {new Date(r.occurredAt).toLocaleString()}
                </td>
                <td className="px-4 py-2">{r.actorEmail ?? r.actorType}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-4 py-2">
                  <Badge variant={r.result === 'SUCCESS' ? 'secondary' : 'destructive'}>
                    {r.result}
                  </Badge>
                  {r.reasonCode ? (
                    <span className="ml-2 font-mono text-xs">{r.reasonCode}</span>
                  ) : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {r.targetType ? `${r.targetType} ` : ''}
                  {r.targetId ?? r.targetOrgId ?? ''}
                </td>
                <td className="max-w-xs px-4 py-2 font-mono text-xs break-all">
                  {r.metadata && Object.keys(r.metadata as object).length > 0
                    ? JSON.stringify(r.metadata)
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && !error ? (
          <p className="px-4 py-6 text-sm text-ink-muted">No entries.</p>
        ) : null}
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? <p className="text-sm text-ink-muted">Loading…</p> : null}
      {next && !loading ? (
        <Button variant="outline" onClick={() => void load(next)}>
          Older entries
        </Button>
      ) : null}
    </div>
  );
}
