'use server';

import { headers } from 'next/headers';
import { requirePermission } from '@/lib/authz/require-permission';
import { queryAuditLogs, queryLoginEvents } from '@/lib/admin/audit';

/** /admin/audit-logs Server Actions — authorize first, always. */

export async function getAuditPageData(filters: {
  action?: string;
  result?: string;
  severity?: string;
}) {
  const auth = await requirePermission(await headers(), { permission: 'audit_logs.view' });
  const [entries, logins] = await Promise.all([
    queryAuditLogs(auth, filters),
    queryLoginEvents(auth, 100),
  ]);
  return { entries, logins };
}
