import { requirePagePermission } from '@/lib/authz/page';
import { getAuditPageData } from './actions';

/**
 * /admin/audit-logs — the append-only audit trail plus the login-event stream.
 * audit_logs.view. The logs cannot be edited or deleted; this page only reads.
 */
export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; result?: string }>;
}) {
  await requirePagePermission('audit_logs.view');
  const filters = await searchParams;
  const { entries, logins } = await getAuditPageData({
    action: filters.action || undefined,
    result: filters.result || undefined,
  });

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit logs</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The append-only record of what happened. Entries cannot be edited or deleted.
        </p>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-medium">Authentication events</h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-cream-dark/50 text-left">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {logins.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-ink-muted">
                    {new Date(l.occurredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{l.eventType}</td>
                  <td className="px-4 py-2">{l.email ?? '—'}</td>
                </tr>
              ))}
              {logins.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-ink-muted">
                    No authentication events yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-medium">Audit trail</h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-cream-dark/50 text-left">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Entity</th>
                <th className="px-4 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-ink-muted">
                    {new Date(e.occurredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">{e.actorLabel ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-4 py-2 text-ink-muted">{e.entityType ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        e.result === 'DENIED' ? 'text-destructive' : 'text-emerald-700'
                      }
                    >
                      {e.result}
                    </span>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                    No audit entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
