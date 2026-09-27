import { PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/state/empty-state';

/**
 * Phase 0 ships nothing user-facing. This placeholder exists so the shell and the
 * state primitives are exercised by a real route — and so the deploy pipeline has
 * something to prove itself against before any feature exists.
 */
export default function Home() {
  return (
    <>
      <PageHeader title="Home" description="Foundation only — features arrive in Phase 1." />
      <EmptyState
        title="Nothing here yet"
        description="Phase 0 builds the guarantees every later phase depends on: one authorized path to the database, row-level security that the runtime role cannot bypass, and a deploy that is proven end to end."
      />
    </>
  );
}
