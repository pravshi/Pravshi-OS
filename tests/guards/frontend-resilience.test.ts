import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 12 Wave C (F-12-05, F-12-07, F-12-08, F-12-09) — frontend resilience
 * and payload contracts, pinned as source guards because the behaviours live
 * in Next.js file conventions and client effects that only a browser could
 * exercise end-to-end:
 *
 *  - route-segment boundaries exist and stay safe (no internals rendered);
 *  - the named fonts are actually loaded (no phantom font names);
 *  - the notification bell polls at 60s and never while hidden;
 *  - the three heavy editor surfaces stay behind next/dynamic.
 */

const read = (path: string) => readFileSync(path, 'utf8');

describe('route resilience boundaries (F-12-05)', () => {
  it('keeps global-error.tsx as the root last resort', () => {
    expect(existsSync('src/app/global-error.tsx')).toBe(true);
  });

  it('(app) error boundary is a client component with retry, home link and Sentry reporting', () => {
    const src = read('src/app/(app)/error.tsx');
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain('Sentry.captureException');
    expect(src).toContain('onClick={reset}');
    expect(src).toContain('href="/"');
  });

  it('segment boundaries render no stack traces or document elements', () => {
    for (const path of [
      'src/app/(app)/error.tsx',
      'src/app/(app)/not-found.tsx',
      'src/app/not-found.tsx',
    ]) {
      const src = read(path);
      expect(src, path).not.toContain('error.stack');
      expect(src, path).not.toContain('.stack');
      // Only global-error.tsx may declare <html>/<body> — segment boundaries
      // render inside the layouts that already provide them.
      expect(src, path).not.toContain('<html');
      expect(src, path).not.toContain('<body');
    }
  });

  it('(app) loading boundary renders a skeleton inside the shell', () => {
    const src = read('src/app/(app)/loading.tsx');
    expect(src).toContain('Skeleton');
    expect(src).toContain('aria-busy');
  });

  it('not-found boundaries offer a way home', () => {
    expect(read('src/app/(app)/not-found.tsx')).toContain('href="/"');
    expect(read('src/app/not-found.tsx')).toContain('href="/"');
  });
});

describe('fonts are loaded, not phantom (F-12-07)', () => {
  it('root layout loads Inter and JetBrains Mono via next/font with swap', () => {
    const src = read('src/app/layout.tsx');
    expect(src).toContain("from 'next/font/google'");
    expect(src).toContain('Inter(');
    expect(src).toContain('JetBrains_Mono(');
    expect(src).toContain("display: 'swap'");
    expect(src).toContain('--font-inter');
    expect(src).toContain('--font-jetbrains-mono');
  });

  it('globals.css consumes the next/font variables and names no unloaded font', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain('var(--font-inter)');
    expect(css).toContain('var(--font-jetbrains-mono)');
    expect(css).not.toContain("'Inter var'");
    expect(css).not.toContain("'JetBrains Mono'");
  });
});

describe('notification bell polling (F-12-08)', () => {
  const src = read('src/components/notifications/NotificationBell.tsx');

  it('polls every 60s, not 30s', () => {
    expect(src).toContain('POLL_INTERVAL_MS = 60_000');
    expect(src).not.toContain('30_000');
  });

  it('pauses while the tab is hidden and refreshes on visibility return', () => {
    expect(src).toContain("document.addEventListener('visibilitychange'");
    expect(src).toContain("document.visibilityState === 'visible'");
  });

  it('still polls the unchanged unread-count endpoint', () => {
    expect(src).toContain("fetch('/api/notifications/unread-count'");
  });
});

describe('heavy editor surfaces are code-split (F-12-09)', () => {
  // ssr:false is load-bearing: a next/dynamic component WITH server rendering
  // is still preloaded into the page's First Load, which defeats the split.
  // Pages are server components (where ssr:false is not allowed), so the
  // dynamic import lives in a small client *Lazy wrapper per surface.
  it('workflow builder on /workflows/new loads through its lazy wrapper', () => {
    const page = read('src/app/(app)/workflows/new/page.tsx');
    expect(page).toContain('WorkflowBuilderLazy');
    expect(page).not.toContain("import { WorkflowBuilder } from '../_components/WorkflowBuilder'");
    const wrapper = read('src/app/(app)/workflows/_components/WorkflowBuilderLazy.tsx');
    expect(wrapper).toContain("from 'next/dynamic'");
    expect(wrapper).toContain("import('./WorkflowBuilder')");
    expect(wrapper).toContain('ssr: false');
    expect(wrapper).toContain('loading:');
  });

  it('workflow editor on /workflows/[id]/edit loads through its lazy wrapper', () => {
    const page = read('src/app/(app)/workflows/[id]/edit/page.tsx');
    expect(page).toContain('EditWorkflowClientLazy');
    expect(page).not.toContain(
      "import { EditWorkflowClient } from '../../_components/EditWorkflowClient'",
    );
    const wrapper = read('src/app/(app)/workflows/_components/EditWorkflowClientLazy.tsx');
    expect(wrapper).toContain("from 'next/dynamic'");
    expect(wrapper).toContain("import('./EditWorkflowClient')");
    expect(wrapper).toContain('ssr: false');
    expect(wrapper).toContain('loading:');
  });

  it("the board's task form is dynamically imported with a fallback", () => {
    const src = read('src/app/(app)/work/_components/TaskBoard.tsx');
    expect(src).toContain("from 'next/dynamic'");
    expect(src).toContain("import('./TaskForm')");
    expect(src).toContain('ssr: false');
    expect(src).toContain('loading:');
    expect(src).not.toMatch(/import \{ TaskForm[, }]/);
  });

  it('the task detail editor loads through its lazy wrapper', () => {
    const page = read('src/app/(app)/work/tasks/[id]/page.tsx');
    expect(page).toContain('EditTaskFormLazy');
    expect(page).not.toContain("import { EditTaskForm } from '../../_components/EditTaskForm'");
    const wrapper = read('src/app/(app)/work/_components/EditTaskFormLazy.tsx');
    expect(wrapper).toContain("from 'next/dynamic'");
    expect(wrapper).toContain("import('./EditTaskForm')");
    expect(wrapper).toContain('ssr: false');
    expect(wrapper).toContain('loading:');
  });
});
