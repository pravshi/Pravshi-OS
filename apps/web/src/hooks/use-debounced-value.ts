import { useEffect, useState } from 'react';

/**
 * useDebouncedValue — returns `value` delayed by `delayMs`.
 *
 * Phase 8 Search Frontend (Workstream D): the typeahead contract (§16.9)
 * requires a 300ms debounce on global-search keystrokes. No such hook
 * existed in the codebase, so it is created here.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
