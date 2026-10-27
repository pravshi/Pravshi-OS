import { z } from 'zod';
import type { PlatformRequest } from '@/lib/platform/guard';
import { BadRequest, readJson, segment } from '@/lib/platform/http';
import { isUuid, setOrganizationStatus } from '@/lib/platform/service';

const Reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });

/** Shared by the suspend and reactivate routes. */
export async function changeStatus(req: Request, ctx: PlatformRequest, to: 'SUSPENDED' | 'ACTIVE') {
  const orgId = segment(req, 'organizations');
  if (!isUuid(orgId)) throw new BadRequest('orgId');
  const parsed = Reason.safeParse(await readJson(req));
  if (!parsed.success) throw new BadRequest('reason');
  return setOrganizationStatus(ctx, orgId, to, parsed.data.reason);
}
