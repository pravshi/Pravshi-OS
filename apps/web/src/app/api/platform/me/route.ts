import { json } from '@/lib/platform/guard';
import { platformRoute } from '@/lib/platform/http';
import { whoami } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/** GET /api/platform/me — the signed-in platform administrator and their permissions. */
export const GET = platformRoute({ operation: 'platform.organization.list' }, async (_req, ctx) =>
  json(200, { admin: await whoami(ctx), sessionFresh: ctx.actor.session.fresh }),
);
