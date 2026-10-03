import { requirePagePermission } from '@/lib/authz/page';
import { getAuditPageData } from './actions';
import { ExportButtons } from './export-buttons';

/**
 * /admin/audit-logs — the append-only audit trail plus the login-event stream.
 * audit_logs.view. The logs cannot be edited or deleted; this page only reads.
 * Exports (CSV/JSON) carry the page's current filters and are themselves audited.
 */
export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; result?: string; severity?: string }>;
}) {
  await requirePagePermission('audit_logs.view');
  const filters = await searchParams;
  const { entries, logins } = await getAuditPageData({
    action: filters.action || undefined,
    result: filters.result || undefined,
    severity: filters.severity || undefined,
  });

  return (
    <div className="space-y-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit logs</h1>
          <p className="mt-1 text-sm text-ink-muted">
            The append-only record of what happened. Entries cannot be edited or deleted.
          </p>
        </div>
        <ExportButtons action={filters.action} result={filters.result} />
      </div>

      <section>
        <h2 className="mb-4 text-lg font-medium">Authentication events</h2>
        <form
          method="GET"
          className="mb-3 flex flex-wrap items-center gap-3 text-sm"
          aria-label="Audit filters"
        >
          <label className="flex items-center gap-2">
            <span className="text-ink-muted">Severity</span>
            <select
              name="severity"
              defaultValue={filters.severity ?? ''}
              className="rounded-md border border-line bg-white px-2 py-1"
            >
              <option value="">All</option>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md border border-line px-3 py-1 text-ink-muted hover:bg-cream-dark"
          >
            Filter
          </button>
          {filters.severity ? (
            <a href="/admin/audit-logs" className="text-ink-muted underline hover:text-ink">
              Clear
            </a>
          ) : null}
        </form>
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
                <th className="px-4 py-2 font-medium">Severity</th>
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
                      className={e.result === 'DENIED' ? 'text-destructive' : 'text-emerald-700'}
                    >
                      {e.result}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        e.severity === 'HIGH'
                          ? 'font-medium text-destructive'
                          : e.severity === 'MEDIUM'
                            ? 'text-amber-700'
                            : 'text-ink-muted'
                      }
                    >
                      {e.severity ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-ink-muted">
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
