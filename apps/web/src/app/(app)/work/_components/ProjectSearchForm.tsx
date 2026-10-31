'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Search input for the Work projects page. Navigates via ?q= URL param. */
export function ProjectSearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const q = query.trim();
    if (q) params.set('q', q);
    else params.delete('q');
    router.push(`/work?${params.toString()}`);
  }

  return (
    <form onSubmit={onSearch} className="flex flex-1 items-center gap-2 sm:max-w-md">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects by name…"
        aria-label="Search projects"
      />
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}
