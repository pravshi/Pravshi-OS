import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * P0-1 (2026-10-03): all 4 CRM detail pages 500'd on main because they passed
 * inline arrow-function closures (e.g. `onSave={(input) => updateCompanyAction(company.id, input)}`)
 * from Server Components into 'use client' components (CompanyForm, DeleteDialog,
 * ActivityForm, StageTransition). React RSC only serializes direct server-action
 * references — bound via `.bind(null, id)` where the id must be pre-filled —
 * never inline closures. Next surfaces this as "Event handlers cannot be passed
 * to Client Component props", a server-side 500 invisible to typecheck.
 *
 * This guard statically forbids inline arrow closures in the on* props of the
 * detail pages, so the regression surfaces in CI instead of production.
 */
const PAGES = [
  'src/app/(app)/crm/companies/[id]/page.tsx',
  'src/app/(app)/crm/contacts/[id]/page.tsx',
  'src/app/(app)/crm/deals/[id]/page.tsx',
  'src/app/(app)/crm/activities/[id]/page.tsx',
] as const;

/** Bound/direct references each detail page must keep wired (guards against "fixing" by deleting the prop). */
const REQUIRED_WIRING: Record<(typeof PAGES)[number], string[]> = {
  'src/app/(app)/crm/companies/[id]/page.tsx': [
    'onSave={updateCompanyAction.bind(null, company.id)}',
    'onDelete={deleteCompanyAction.bind(null, company.id)}',
  ],
  'src/app/(app)/crm/contacts/[id]/page.tsx': [
    'onSave={updateContactAction.bind(null, contact.id)}',
    'onDelete={deleteContactAction.bind(null, contact.id)}',
  ],
  'src/app/(app)/crm/deals/[id]/page.tsx': [
    'onSave={updateDealAction.bind(null, deal.id)}',
    'onDelete={deleteDealAction.bind(null, deal.id)}',
    'onTransition={updateDealAction}',
  ],
  'src/app/(app)/crm/activities/[id]/page.tsx': [
    'onSave={updateActivityAction.bind(null, activity.id)}',
    'onDelete={deleteActivityAction.bind(null, activity.id)}',
  ],
};

/**
 * Returns the names of on* props whose value opens with an inline arrow
 * closure: `(…) =>`, `async (…) =>`, or a bare param `input =>`.
 * Bound references (`fn.bind(null, id)`) and direct actions (`fn`) never
 * open with `(` or a bare-param arrow, so they pass.
 */
function inlineClosureProps(source: string): string[] {
  const compact = source.replace(/\s+/g, '');
  const offenders: string[] = [];
  const re = /on[A-Z][A-Za-z]*=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(compact)) !== null) {
    const rest = compact.slice(re.lastIndex);
    if (/^\(/.test(rest) || /^async\(/.test(rest) || /^[A-Za-z_$][\w$]*=>/.test(rest)) {
      offenders.push(m[0].slice(0, -2));
    }
  }
  return offenders;
}

describe('CRM detail pages: no inline closures passed to client components', () => {
  for (const page of PAGES) {
    it(`${page} passes only bound or direct server-action references`, () => {
      const source = readFileSync(page, 'utf8');
      const offenders = inlineClosureProps(source);
      expect(
        offenders,
        `Inline closure props are not serializable to client components — ` +
          `use .bind(null, id) or the direct action reference. ` +
          `Offenders: ${offenders.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('detail pages keep their save/delete actions wired', () => {
    for (const page of PAGES) {
      const source = readFileSync(page, 'utf8');
      for (const wiring of REQUIRED_WIRING[page]) {
        expect(
          source,
          `${page} lost its ${wiring.split('=')[0]} wiring — a missing handler is a silent regression`,
        ).toContain(wiring);
      }
    }
  });
});
