/**
 * Sales Sheet duplicate resolution — the database-free core. A decision is made once per company
 * or contact (and per deal key) and every row naming that entity follows it; the preview is
 * rebuilt from the decisions, so each decision recalculates what the rest of the file will do.
 * Nothing is ever created as a duplicate without an explicit decision. Representative fixtures
 * only: the real sheet's mapping is pending (tests/fixtures/sales-sheet/README.md).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@/lib/import/sales-sheet/csv';
import { REPRESENTATIVE_MAPPING } from '@/lib/import/sales-sheet/mapping';
import {
  buildPreview,
  normaliseKey,
  type DuplicateDecision,
  type ImportDecisions,
  type OrgSnapshot,
} from '@/lib/import/sales-sheet/preview';

const OWNER = '11111111-1111-4111-8111-111111111111';
const snapshot = (over: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  companyDomains: new Set(),
  companyNames: new Set([normaliseKey('Name Only Ltd')]),
  contactEmails: new Map(),
  contactNameCompany: new Set([`${normaliseKey('Asha Rao')}|name:name only ltd`]),
  dealKeys: new Set(['renewal|name:name only ltd|name:asha rao|name:name only ltd']),
  activeOwnersByEmail: new Map([['owner.one@pravshi.example', OWNER]]),
  completedFileHashes: new Set(),
  ...over,
});
const bytes = (s: string) => new TextEncoder().encode(s);
const HEADER = 'Company,Contact First Name,Contact Last Name,Deal Title,Owner Email\n';
const FILE = bytes(
  HEADER +
    'Name Only Ltd,Asha,Rao,Renewal,owner.one@pravshi.example\n' +
    'Name Only Ltd,Ben,Roy,Upsell,owner.one@pravshi.example\n' +
    'Fresh Co,Cy,Lee,New deal,owner.one@pravshi.example\n',
);
const COMPANY = 'name:name only ltd';
const ASHA = 'name:asha rao|name:name only ltd';
const ASHA_DEAL = 'renewal|name:name only ltd|name:asha rao|name:name only ltd';

const decide = (d: {
  companies?: [string, DuplicateDecision][];
  contacts?: [string, DuplicateDecision][];
  deals?: [string, 'CREATE_NEW' | 'SKIP'][];
}): ImportDecisions => ({
  companies: new Map(d.companies ?? []),
  contacts: new Map(d.contacts ?? []),
  deals: new Map(d.deals ?? []),
});
const preview = (decisions?: ImportDecisions, snap = snapshot()) =>
  buildPreview(FILE, REPRESENTATIVE_MAPPING, snap, DEFAULT_LIMITS, decisions);
const outcomes = (p: ReturnType<typeof preview>) =>
  p.validRows.map((r) => [r.rowNumber, r.company, r.contact, r.deal]);

describe('undecided: nothing is created as a duplicate', () => {
  it('reports each undecided entity once, however many rows name it', () => {
    const p = preview();
    // Undecided, the company may be the existing one — so Asha may be its existing contact and
    // her deal its existing deal: every possible duplicate is surfaced.
    expect(p.unresolved).toEqual({ companies: [COMPANY], contacts: [ASHA], deals: [ASHA_DEAL] });
    expect(outcomes(p)).toEqual([
      [2, 'POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE'],
      [3, 'POSSIBLE_DUPLICATE', 'CREATE', 'CREATE'],
      [4, 'CREATE', 'CREATE', 'CREATE'],
    ]);
    // Only the unrelated row would be created; both rows of the undecided company wait.
    expect(p.counts.companies).toEqual({ create: 1, link: 0, possibleDuplicate: 2 });
    expect(p.skippedRows).toEqual([]);
  });
});

describe('a company decision applies to every row naming it, and recalculates the rest', () => {
  it('use the existing company: its existing contact and deal surface as possible duplicates', () => {
    const p = preview(decide({ companies: [[COMPANY, 'LINK_EXISTING']] }));
    expect(outcomes(p)).toEqual([
      [2, 'LINK', 'POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE'],
      [3, 'LINK', 'CREATE', 'CREATE'],
      [4, 'CREATE', 'CREATE', 'CREATE'],
    ]);
    expect(p.unresolved).toEqual({ companies: [], contacts: [ASHA], deals: [ASHA_DEAL] });
  });

  it('create a new company: nothing of the existing one can collide any more', () => {
    const p = preview(decide({ companies: [[COMPANY, 'CREATE_NEW']] }));
    expect(outcomes(p)).toEqual([
      [2, 'CREATE', 'CREATE', 'CREATE'],
      [3, 'LINK', 'CREATE', 'CREATE'],
      [4, 'CREATE', 'CREATE', 'CREATE'],
    ]);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    // Created once, linked by the second row.
    expect(p.counts.companies).toEqual({ create: 2, link: 1, possibleDuplicate: 0 });
  });

  it('skip: every row naming the company is excluded, the rest unaffected', () => {
    const p = preview(decide({ companies: [[COMPANY, 'SKIP']] }));
    expect(p.skippedRows).toEqual([2, 3]);
    expect(outcomes(p)).toEqual([[4, 'CREATE', 'CREATE', 'CREATE']]);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
  });
});

describe('contact and deal decisions, after the company decision', () => {
  const linked = (more: Parameters<typeof decide>[0]) =>
    preview(decide({ companies: [[COMPANY, 'LINK_EXISTING']], ...more }));

  it('use the existing contact; then the deal is still a possible duplicate', () => {
    const p = linked({ contacts: [[ASHA, 'LINK_EXISTING']] });
    expect(outcomes(p)[0]).toEqual([2, 'LINK', 'LINK', 'POSSIBLE_DUPLICATE']);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [ASHA_DEAL] });
  });

  it('a new contact cannot have the existing deal: the deal stops being a duplicate', () => {
    const p = linked({ contacts: [[ASHA, 'CREATE_NEW']] });
    expect(outcomes(p)[0]).toEqual([2, 'LINK', 'CREATE', 'CREATE']);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
  });

  it('deal decisions: create anyway, or skip the row', () => {
    const create = linked({
      contacts: [[ASHA, 'LINK_EXISTING']],
      deals: [[ASHA_DEAL, 'CREATE_NEW']],
    });
    expect(outcomes(create)[0]).toEqual([2, 'LINK', 'LINK', 'CREATE']);
    expect(create.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    const skip = linked({ contacts: [[ASHA, 'LINK_EXISTING']], deals: [[ASHA_DEAL, 'SKIP']] });
    expect(skip.skippedRows).toEqual([2]);
  });
});

describe('decisions the import refuses rather than guess', () => {
  it('"use the existing company" when more than one company has that name', () => {
    const p = preview(
      decide({ companies: [[COMPANY, 'LINK_EXISTING']] }),
      snapshot({ companyNameCounts: new Map([[normaliseKey('Name Only Ltd'), 2]]) }),
    );
    expect(p.invalidRows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(p.invalidRows[0]!.errors[0]!.reason).toMatch(/more than one existing company/);
  });

  it('"create a new company" when a row links a contact of the existing one', () => {
    const p = buildPreview(
      bytes(
        'Company,Contact First Name,Contact Last Name,Contact Email,Owner Email\n' +
          'Name Only Ltd,Bob,Lee,bob@x.example,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot({ contactEmails: new Map([['bob@x.example', COMPANY]]) }),
      DEFAULT_LIMITS,
      decide({ companies: [[COMPANY, 'CREATE_NEW']] }),
    );
    expect(p.validRows).toEqual([]);
    expect(p.invalidRows[0]!.errors.map((e) => e.reason)).toContain(
      'belongs to a contact of the existing company; use the existing company, or skip',
    );
  });

  it('a decision for an entity that is not a possible duplicate changes nothing', () => {
    const before = preview();
    const after = preview(decide({ companies: [['name:fresh co', 'SKIP']] }));
    expect(outcomes(after)).toEqual(outcomes(before));
    expect(after.skippedRows).toEqual([]);
  });
});
