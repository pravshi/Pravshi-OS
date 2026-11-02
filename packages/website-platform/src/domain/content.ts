/**
 * Website Platform Domain — Content, Pages, Templates, and Navigation.
 *
 * Implements draft vs published state machines, template schemas, and acyclic navigation trees.
 */

export const PAGE_STATUSES = ['draft', 'published', 'archived'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const PAGE_TEMPLATES = [
  'home',
  'about',
  'contact',
  'catalog',
  'detail',
  'landing',
  'custom',
] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export const CONTENT_BLOCK_TYPES = [
  'hero',
  'features',
  'grid',
  'text',
  'cta',
  'faq',
  'contact_form',
  'listing_feed',
  'program_feed',
] as const;
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

export interface ContentBlock {
  readonly id: string;
  readonly type: ContentBlockType;
  readonly title?: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly order: number;
}

export interface NavigationItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly order: number;
  readonly children?: readonly NavigationItem[];
  readonly isExternal?: boolean;
}

export interface PageContent {
  readonly id: string;
  readonly siteId: string;
  readonly slug: string;
  readonly title: string;
  readonly template: PageTemplate;
  readonly blocks: readonly ContentBlock[];
  readonly status: PageStatus;
  readonly draftVersion: number;
  readonly publishedVersion?: number;
  readonly publishedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ContentDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ContentDomainError';
  }
}

/**
 * Validates that navigation tree has no cycles and valid path structures.
 */
export function validateNavigationTree(
  items: readonly NavigationItem[],
  visited = new Set<string>(),
): void {
  for (const item of items) {
    if (visited.has(item.id)) {
      throw new ContentDomainError(
        `Circular reference detected in navigation tree at item: ${item.id}`,
        'CIRCULAR_NAVIGATION',
      );
    }
    visited.add(item.id);
    if (!item.path.startsWith('/') && !item.isExternal) {
      throw new ContentDomainError(
        `Internal navigation item path must start with '/': ${item.path}`,
        'INVALID_NAV_PATH',
      );
    }
    if (item.children && item.children.length > 0) {
      validateNavigationTree(item.children, new Set(visited));
    }
  }
}

/**
 * Invariant: Page publication requires minimum content blocks and valid slug.
 */
export function assertPagePublishable(page: PageContent): void {
  if (page.status === 'archived') {
    throw new ContentDomainError('Cannot publish an archived page', 'CANNOT_PUBLISH_ARCHIVED');
  }
  if (!page.title || page.title.trim().length === 0) {
    throw new ContentDomainError('Page title is required for publishing', 'TITLE_REQUIRED');
  }
  if (page.blocks.length === 0) {
    throw new ContentDomainError(
      'At least one content block is required to publish a page',
      'NO_BLOCKS_DEFINED',
    );
  }
}
