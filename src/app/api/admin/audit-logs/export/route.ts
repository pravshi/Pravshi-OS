import { randomUUID } from 'node:crypto';
import { withPermission } from '@/lib/authz/http';
import { checkIpRateLimit } from '@/lib/auth/rate-limit';
import { requestMetadata, writeAuditEntry } from '@/lib/audit/log';
import {
  EXPORT_ROW_CAP,
  countAuditExportRows,
  streamAuditExportBatches,
  auditRecordToCsvRow,
  auditRecordToJson,
  AUDIT_CSV_HEADER,
  type AuditExportRecord,
} from '@/lib/admin/audit-export';

export const dynamic = 'force-dynamic';

const MAX_FILTER_CHARS = 128;

/**
 * GET /api/admin/audit-logs/export?format=csv|json&action=…&result=…
 *
 * Downloads the currently filtered audit trail. audit_logs.view at GLOBAL scope —
 * the same breadth the page demands, and the breadth the audit_logs RLS policy
 * requires — so a narrower caller fails here with a clean 403 instead of an empty
 * export later.
 *
 * The body streams: rows are fetched in keyset-paginated batches and serialized
 * incrementally, so memory stays bounded to one batch. At most EXPORT_ROW_CAP rows
 * are delivered; truncation is signalled with X-Export-Truncated (and the exact
 * row count with X-Export-Row-Count), both computed up front so they can ride on
 * the response headers.
 *
 * Every completed export writes its own MEDIUM audit entry (audit.export) naming
 * the format, the filters, and the row count — the export of the trail is itself
 * on the trail.
 *
 * Rate limited per user (Phase 11, F-11-09): the export is deliberately heavy
 * (a full count plus a streamed scan of the trail), so each person gets a
 * small fixed-window allowance on the authz.check_rate_limit substrate,
 * checked before any of that work starts. Legitimate use — a person pulling
 * a report — never approaches 5/min; a scripted caller meets a 429 instead
 * of a scan.
 */

/** F-11-09 contract value: per-user allowance for the export. */
const AUDIT_EXPORT_RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = withPermission(
  { permission: 'audit_logs.view', minScope: 'GLOBAL' },
  async (request, authorization) => {
    if (
      !(await checkIpRateLimit(
        `audit-export:user:${authorization.ctx.personId}`,
        AUDIT_EXPORT_RATE_LIMIT_PER_MINUTE,
        RATE_LIMIT_WINDOW_SECONDS,
      ))
    ) {
      return Response.json(
        { error: 'RATE_LIMITED', message: 'Too many export requests. Please try again later.' },
        { status: 429, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const url = new URL(request.url);
    const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'format must be csv or json.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const rawAction = url.searchParams.get('action') ?? undefined;
    const rawResult = url.searchParams.get('result') ?? undefined;
    for (const [name, value] of [
      ['action', rawAction],
      ['result', rawResult],
    ] as const) {
      if (value !== undefined && (value.length === 0 || value.length > MAX_FILTER_CHARS)) {
        return Response.json(
          { error: 'INVALID_REQUEST', message: `${name} filter must be 1–128 characters.` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
    const filters = { action: rawAction, result: rawResult };

    const requestId = randomUUID();
    const meta = requestMetadata(request.headers, requestId);

    // Rows are append-only, so the count can only grow between here and the
    // stream; the cap keeps the delivered count exact regardless.
    const total = await countAuditExportRows(authorization, filters);
    const truncated = total > EXPORT_ROW_CAP;
    const rowCount = Math.min(total, EXPORT_ROW_CAP);

    let streamed = 0;
    const recordExport = (outcome: 'SUCCESS' | 'ERROR') =>
      writeAuditEntry(
        authorization.ctx,
        {
          action: 'audit.export',
          entityType: 'audit_log',
          result: outcome,
          severity: 'MEDIUM',
          metadata: {
            format,
            action_filter: filters.action ?? null,
            result_filter: filters.result ?? null,
            row_count: streamed,
            truncated,
          },
        },
        meta,
      ).catch((e) => {
        // The export already happened (or failed); a lost audit row must not
        // rewrite that outcome. Logged, never thrown.
        console.error('[audit-export] export audit entry failed', {
          requestId,
          name: e instanceof Error ? e.name : typeof e,
        });
      });

    const stream = new ReadableStream<string>({
      async start(controller) {
        try {
          const enqueue = (s: string) => controller.enqueue(s);
          if (format === 'csv') {
            enqueue(AUDIT_CSV_HEADER + '\r\n');
            await streamAuditExportBatches(authorization, filters, (batch: AuditExportRecord[]) => {
              streamed += batch.length;
              enqueue(batch.map((r) => auditRecordToCsvRow(r)).join('\r\n') + '\r\n');
            });
          } else {
            enqueue('[');
            let first = true;
            await streamAuditExportBatches(authorization, filters, (batch: AuditExportRecord[]) => {
              for (const r of batch) {
                streamed += 1;
                enqueue((first ? '' : ',') + JSON.stringify(auditRecordToJson(r)));
                first = false;
              }
            });
            enqueue(']');
          }
          // Written before the stream closes, so the export lands on the record
          // before the response — and the serverless invocation — completes.
          await recordExport('SUCCESS');
          controller.close();
        } catch (e) {
          console.error('[audit-export] export stream failed', {
            requestId,
            name: e instanceof Error ? e.name : typeof e,
          });
          await recordExport('ERROR');
          controller.error(e instanceof Error ? e : new Error('export failed'));
        }
      },
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type':
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-logs-${stamp}.${format}"`,
        'Cache-Control': 'no-store',
        'X-Export-Row-Count': String(rowCount),
        ...(truncated ? { 'X-Export-Truncated': 'true' } : {}),
      },
    });
  },
);
