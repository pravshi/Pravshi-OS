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
const EXISTING_CO = 'c0000000-0000-4000-8000-000000000001';
const ASHA_ID = 'a0000000-0000-4000-8000-000000000001';
const snapshot = (over: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  companyDomains: new Set(),
  companyNames: new Set([normaliseKey('Name Only Ltd')]),
  contactEmails: new Map(),
  contactNameCompany: new Set([`${normaliseKey('Asha Rao')}|name:name only ltd`]),
  companyIdsByName: new Map([[normaliseKey('Name Only Ltd'), [EXISTING_CO]]]),
  contactIdsByNameCompany: new Map([[`${normaliseKey('Asha Rao')}|name:name only ltd`, [ASHA_ID]]]),
  companyKeyById: new Map([[EXISTING_CO, 'name:name only ltd']]),
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
      snapshot({
        companyIdsByName: new Map([[normaliseKey('Name Only Ltd'), [EXISTING_CO, OWNER]]]),
      }),
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

describe('a decision travels with its entity to later rows (review DR-2, DR-3)', () => {
  const B = (rows: string) =>
    bytes(
      'Company,Contact First Name,Contact Last Name,Contact Email,Deal Title,Owner Email\n' + rows,
    );
  const O = 'owner.one@pravshi.example';
  const run = (file: Uint8Array, decisions: ImportDecisions, snap = snapshot()) =>
    buildPreview(file, REPRESENTATIVE_MAPPING, snap, DEFAULT_LIMITS, decisions);

  it('later rows of a company marked new: an existing contact email is refused, as on its first row', () => {
    const p = run(
      B(`Name Only Ltd,Cy,Lee,,,${O}\nName Only Ltd,Bob,Lee,bob@x.example,,${O}\n`),
      decide({ companies: [[COMPANY, 'CREATE_NEW']] }),
      snapshot({ contactEmails: new Map([['bob@x.example', COMPANY]]) }),
    );
    expect(p.validRows.map((r) => r.rowNumber)).toEqual([2]);
    expect(p.invalidRows.map((r) => r.rowNumber)).toEqual([3]);
    expect(p.invalidRows[0]!.errors.map((e) => e.reason)).toContain(
      'belongs to a contact of the existing company; use the existing company, or skip',
    );
  });

  it('later rows of a company marked new: the old company’s contact and deal never collide', () => {
    const p = run(
      B(`Name Only Ltd,Cy,Lee,,,${O}\nName Only Ltd,Asha,Rao,,Renewal,${O}\n`),
      decide({ companies: [[COMPANY, 'CREATE_NEW']] }),
    );
    expect(outcomes(p)).toEqual([
      [2, 'CREATE', 'CREATE', null],
      [3, 'LINK', 'CREATE', 'CREATE'],
    ]);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    expect(p.validRows.every((r) => r.existingCompanyId === null)).toBe(true);
  });

  it('"use the existing" records the chosen ids on every row of that entity', () => {
    const p = run(
      B(`Name Only Ltd,Asha,Rao,,,${O}\nName Only Ltd,Asha,Rao,,,${O}\n`),
      decide({ companies: [[COMPANY, 'LINK_EXISTING']], contacts: [[ASHA, 'LINK_EXISTING']] }),
    );
    expect(p.validRows.map((r) => [r.existingCompanyId, r.existingContactId])).toEqual([
      [EXISTING_CO, ASHA_ID],
      [EXISTING_CO, ASHA_ID],
    ]);
  });

  it('a contact decision a company decision made moot is not applied (no stale link)', () => {
    // Decided "use the existing Asha", then the company was marked new: Asha is a new contact
    // of the new company; the plan must not link the old one.
    const p = preview(
      decide({ companies: [[COMPANY, 'CREATE_NEW']], contacts: [[ASHA, 'LINK_EXISTING']] }),
    );
    expect(outcomes(p)[0]).toEqual([2, 'CREATE', 'CREATE', 'CREATE']);
    expect(p.validRows[0]!.existingContactId).toBeNull();
  });

  it('"use the existing contact" is refused when the name matches several of that company', () => {
    const p = preview(
      decide({ companies: [[COMPANY, 'LINK_EXISTING']], contacts: [[ASHA, 'LINK_EXISTING']] }),
      snapshot({
        contactIdsByNameCompany: new Map([
          [`${normaliseKey('Asha Rao')}|name:name only ltd`, [ASHA_ID, OWNER]],
        ]),
      }),
    );
    expect(p.invalidRows.map((r) => r.rowNumber)).toEqual([2]);
    expect(p.invalidRows[0]!.errors[0]!.reason).toMatch(/more than one existing contact/);
  });
});

describe('"use the existing company" compares with that company’s own records (review R-1)', () => {
  // The organization's Acme has a domain: its contacts and deals are filed under domain:acme.com.
  // The file names Acme by name only. Linked by decision, the row must meet those records.
  const ACME = 'c0000000-0000-4000-8000-0000000000ac';
  const JOHN = 'a0000000-0000-4000-8000-0000000000ac';
  const acme = snapshot({
    companyDomains: new Set(['acme.com']),
    companyNames: new Set(['acme']),
    companyIdsByName: new Map([['acme', [ACME]]]),
    companyKeyById: new Map([[ACME, 'domain:acme.com']]),
    contactEmails: new Map([['jo@acme.com', 'domain:acme.com']]),
    contactNameCompany: new Set(['john smith|domain:acme.com']),
    contactIdsByNameCompany: new Map([['john smith|domain:acme.com', [JOHN]]]),
    dealKeys: new Set(['renewal|domain:acme.com|name:john smith|domain:acme.com']),
  });
  const file = (rows: string) =>
    bytes(
      'Company,Contact First Name,Contact Last Name,Contact Email,Deal Title,Owner Email\n' + rows,
    );
  const O = 'owner.one@pravshi.example';

  it('its name-matched contact and deal surface as possible duplicates — never created silently', () => {
    const p = buildPreview(
      file(`Acme,John,Smith,,Renewal,${O}\n`),
      REPRESENTATIVE_MAPPING,
      acme,
      DEFAULT_LIMITS,
      decide({ companies: [['name:acme', 'LINK_EXISTING']] }),
    );
    expect(outcomes(p)).toEqual([[2, 'LINK', 'POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE']]);
    expect(p.validRows[0]!.existingCompanyId).toBe(ACME);
    // "Use the existing John" resolves to the domain company's John.
    const linked = buildPreview(
      file(`Acme,John,Smith,,,${O}\n`),
      REPRESENTATIVE_MAPPING,
      acme,
      DEFAULT_LIMITS,
      decide({
        companies: [['name:acme', 'LINK_EXISTING']],
        contacts: [['name:john smith|name:acme', 'LINK_EXISTING']],
      }),
    );
    expect(linked.validRows[0]!.existingContactId).toBe(JOHN);
  });

  it('its existing contact by email links instead of being refused as another company’s', () => {
    const p = buildPreview(
      file(`Acme,Jo,Lee,jo@acme.com,,${O}\n`),
      REPRESENTATIVE_MAPPING,
      acme,
      DEFAULT_LIMITS,
      decide({ companies: [['name:acme', 'LINK_EXISTING']] }),
    );
    expect(p.invalidRows).toEqual([]);
    expect(outcomes(p)).toEqual([[2, 'LINK', 'LINK', null]]);
  });
});

describe('keys never carry a control character (review R-2)', () => {
  it('control characters count as whitespace', () => {
    expect(normaliseKey('  Acme\u0001\u007f Ltd\t')).toBe('acme ltd');
    expect(normaliseKey('A\u0085B')).toBe('a b');
  });
});
