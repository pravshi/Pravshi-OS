/**
 * Application Use Case — Publish Website Content.
 */

import type { Authorization } from '@/lib/authz/require-permission';
import type { Tx } from '@/lib/db/authorized';
import { type PageContent, assertPagePublishable } from '../domain/content';
import { type Site } from '../domain/site';

export interface ContentRepository {
  getPage(siteId: string, pageId: string, tx?: Tx): Promise<PageContent | null>;
  getSite(siteId: string, tx?: Tx): Promise<Site | null>;
  savePage(page: PageContent, tx?: Tx): Promise<PageContent>;
}

export interface PublishContentDependencies {
  readonly contentRepository: ContentRepository;
  readonly emitEvent?: (event: unknown) => Promise<void>;
}

export async function publishContent(
  auth: Authorization,
  siteId: string,
  pageId: string,
  deps: PublishContentDependencies,
  tx?: Tx,
): Promise<PageContent> {
  const site = await deps.contentRepository.getSite(siteId, tx);
  if (!site) {
    throw new Error(`Site not found: ${siteId}`);
  }

  if (site.organizationId !== auth.ctx.orgId) {
    throw new Error('Tenant context mismatch: unauthorized access to site');
  }

  const page = await deps.contentRepository.getPage(siteId, pageId, tx);
  if (!page) {
    throw new Error(`Page not found: ${pageId}`);
  }

  assertPagePublishable(page);

  const newVersion = (page.publishedVersion ?? 0) + 1;
  const publishedAt = new Date();

  const updatedPage: PageContent = {
    ...page,
    status: 'published',
    publishedVersion: newVersion,
    publishedAt,
    updatedAt: publishedAt,
  };

  const saved = await deps.contentRepository.savePage(updatedPage, tx);

  if (deps.emitEvent) {
    await deps.emitEvent({
      type: 'website.site.published',
      organizationId: auth.ctx.orgId,
      actorId: auth.ctx.personId,
      timestamp: publishedAt.toISOString(),
      payload: {
        siteId: site.id,
        pageId: saved.id,
        slug: saved.slug,
        publishedVersion: newVersion,
        publishedAt: publishedAt.toISOString(),
      },
    });
  }

  return saved;
}
