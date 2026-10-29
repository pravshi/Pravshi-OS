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
  companyKeyOf,
  contactEmailKey,
  contactNameKey,
  dealKeyOf,
  normaliseKey,
  repeatDealKeyOf,
  type DuplicateDecision,
  type ImportDecisions,
  type OrgSnapshot,
} from '@/lib/import/sales-sheet/preview';

/** Entity keys, built as the import builds them (review R-15). */
const CO = (name: string) => companyKeyOf(null, name);
const DOM = (domain: string) => companyKeyOf(domain, '');

const OWNER = '11111111-1111-4111-8111-111111111111';
const EXISTING_CO = 'c0000000-0000-4000-8000-000000000001';
const ASHA_ID = 'a0000000-0000-4000-8000-000000000001';
const snapshot = (over: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  companyDomains: new Set(),
  companyNames: new Set([normaliseKey('Name Only Ltd')]),
  contactEmails: new Map(),
  contactNameCompany: new Set([contactNameKey(normaliseKey('Asha Rao'), CO('Name Only Ltd'))]),
  companyIdsByName: new Map([[normaliseKey('Name Only Ltd'), [EXISTING_CO]]]),
  contactIdsByNameCompany: new Map([
    [contactNameKey(normaliseKey('Asha Rao'), CO('Name Only Ltd')), [ASHA_ID]],
  ]),
  companyKeyById: new Map([[EXISTING_CO, CO('Name Only Ltd')]]),
  contactKeyById: new Map([[ASHA_ID, contactNameKey('asha rao', CO('Name Only Ltd'))]]),
  dealKeys: new Set([
    dealKeyOf('renewal', CO('Name Only Ltd'), contactNameKey('asha rao', CO('Name Only Ltd'))),
  ]),
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
const COMPANY = CO('Name Only Ltd');
const ASHA = contactNameKey('asha rao', CO('Name Only Ltd'));
const ASHA_DEAL = dealKeyOf(
  'renewal',
  CO('Name Only Ltd'),
  contactNameKey('asha rao', CO('Name Only Ltd')),
);

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
    const after = preview(decide({ companies: [[CO('Fresh Co'), 'SKIP']] }));
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
          [contactNameKey(normaliseKey('Asha Rao'), CO('Name Only Ltd')), [ASHA_ID, OWNER]],
        ]),
      }),
    );
    expect(p.invalidRows.map((r) => r.rowNumber)).toEqual([2]);
    expect(p.invalidRows[0]!.errors[0]!.reason).toMatch(/more than one existing contact/);
  });
});

describe('"use the existing company" compares with that company’s own records (review R-1)', () => {
  // The organization's Acme has a domain: its contacts and deals are filed under its domain key.
  // The file names Acme by name only. Linked by decision, the row must meet those records.
  const ACME = 'c0000000-0000-4000-8000-0000000000ac';
  const JOHN = 'a0000000-0000-4000-8000-0000000000ac';
  const acme = snapshot({
    companyDomains: new Set(['acme.com']),
    companyNames: new Set(['acme']),
    companyIdsByName: new Map([['acme', [ACME]]]),
    companyKeyById: new Map([[ACME, DOM('acme.com')]]),
    contactKeyById: new Map([[JOHN, contactNameKey('john smith', DOM('acme.com'))]]),
    contactEmails: new Map([['jo@acme.com', DOM('acme.com')]]),
    contactNameCompany: new Set([contactNameKey('john smith', DOM('acme.com'))]),
    contactIdsByNameCompany: new Map([[contactNameKey('john smith', DOM('acme.com')), [JOHN]]]),
    dealKeys: new Set([
      dealKeyOf('renewal', DOM('acme.com'), contactNameKey('john smith', DOM('acme.com'))),
    ]),
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
      decide({ companies: [[CO('Acme'), 'LINK_EXISTING']] }),
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
        companies: [[CO('Acme'), 'LINK_EXISTING']],
        contacts: [[contactNameKey('john smith', CO('Acme')), 'LINK_EXISTING']],
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
      decide({ companies: [[CO('Acme'), 'LINK_EXISTING']] }),
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

describe('"use the existing contact" compares with that contact’s own deals (review R-11)', () => {
  // The existing John has an email: his deals are filed under his email key. The file names
  // him without it, so he is matched by name — and once linked, his deals must still be found.
  const JOHN_ID = 'a0000000-0000-4000-8000-0000000000bb';
  const O = 'owner.one@pravshi.example';
  const file = bytes(
    'Company,Contact First Name,Contact Last Name,Deal Title,Owner Email\n' +
      `Acme,John,Smith,Renewal,${O}\n`,
  );
  const decided = decide({
    companies: [[CO('Acme'), 'LINK_EXISTING']],
    contacts: [[contactNameKey('john smith', CO('Acme')), 'LINK_EXISTING']],
  });
  for (const [label, companyKey, domains] of [
    ['with a company domain', DOM('acme.com'), ['acme.com']],
    ['without one', CO('Acme'), []],
  ] as const) {
    it(`the linked contact's existing deal is a possible duplicate (${label})`, () => {
      const ACME_ID = 'c0000000-0000-4000-8000-0000000000bb';
      const p = buildPreview(
        file,
        REPRESENTATIVE_MAPPING,
        snapshot({
          companyDomains: new Set(domains),
          companyNames: new Set(['acme']),
          companyIdsByName: new Map([['acme', [ACME_ID]]]),
          companyKeyById: new Map([[ACME_ID, companyKey]]),
          contactEmails: new Map([['john@acme.com', companyKey]]),
          contactNameCompany: new Set([contactNameKey('john smith', companyKey)]),
          contactIdsByNameCompany: new Map([[contactNameKey('john smith', companyKey), [JOHN_ID]]]),
          contactKeyById: new Map([[JOHN_ID, contactEmailKey('john@acme.com')]]),
          dealKeys: new Set([dealKeyOf('renewal', companyKey, contactEmailKey('john@acme.com'))]),
        }),
        DEFAULT_LIMITS,
        decided,
      );
      expect(outcomes(p)).toEqual([[2, 'LINK', 'LINK', 'POSSIBLE_DUPLICATE']]);
      expect(p.validRows[0]!.existingContactId).toBe(JOHN_ID);
    });
  }
});

describe('"create anyway" creates the selected deal once; repeats are reviewed one by one (R-3)', () => {
  const O = 'owner.one@pravshi.example';
  const file = (rows: string) =>
    bytes('Company,Contact First Name,Contact Last Name,Deal Title,Owner Email\n' + rows);

  it('a repeat of a deal the file creates is its own possible duplicate, decided per row', () => {
    const f = file(`Fresh Co,Cy,Lee,Big deal,${O}\nFresh Co,Cy,Lee,Big deal,${O}\n`);
    const repeat = repeatDealKeyOf(
      dealKeyOf('big deal', CO('Fresh Co'), contactNameKey('cy lee', CO('Fresh Co'))),
      3,
    );
    const undecided = buildPreview(f, REPRESENTATIVE_MAPPING, snapshot(), DEFAULT_LIMITS);
    expect(outcomes(undecided)).toEqual([
      [2, 'CREATE', 'CREATE', 'CREATE'],
      [3, 'LINK', 'LINK', 'POSSIBLE_DUPLICATE'],
    ]);
    expect(undecided.unresolved.deals).toEqual([repeat]);
    const created = buildPreview(
      f,
      REPRESENTATIVE_MAPPING,
      snapshot(),
      DEFAULT_LIMITS,
      decide({ deals: [[repeat, 'CREATE_NEW']] }),
    );
    expect(created.counts.deals).toEqual({ create: 2, link: 0, possibleDuplicate: 0 });
    const skipped = buildPreview(
      f,
      REPRESENTATIVE_MAPPING,
      snapshot(),
      DEFAULT_LIMITS,
      decide({ deals: [[repeat, 'SKIP']] }),
    );
    expect(skipped.skippedRows).toEqual([3]);
  });

  it('"create anyway" on an existing deal creates it once; the identical repeat stays flagged', () => {
    const f = file(`Name Only Ltd,Asha,Rao,Renewal,${O}\nName Only Ltd,Asha,Rao,Renewal,${O}\n`);
    const p = buildPreview(
      f,
      REPRESENTATIVE_MAPPING,
      snapshot(),
      DEFAULT_LIMITS,
      decide({
        companies: [[COMPANY, 'LINK_EXISTING']],
        contacts: [[ASHA, 'LINK_EXISTING']],
        deals: [[ASHA_DEAL, 'CREATE_NEW']],
      }),
    );
    expect(outcomes(p)).toEqual([
      [2, 'LINK', 'LINK', 'CREATE'],
      [3, 'LINK', 'LINK', 'POSSIBLE_DUPLICATE'],
    ]);
    expect(p.unresolved.deals).toEqual([repeatDealKeyOf(ASHA_DEAL, 3)]);
    expect(p.counts.deals.create).toBe(1);
  });
});

describe('entity keys are unambiguous, whatever the values contain (review R-15)', () => {
  it('values carrying the old "|" separator never make two entities share a key', () => {
    // Each pair collided when keys were values joined with "|".
    expect(contactNameKey('bo x|name:acme', CO('Zed'))).not.toBe(
      contactNameKey('bo x', CO('acme|name:zed')),
    );
    expect(dealKeyOf('t|name:acme', CO('B'), '')).not.toBe(dealKeyOf('t', CO('acme|name:b'), ''));
    const deal = dealKeyOf('big deal', CO('Fresh Co'), contactNameKey('cy lee', CO('Fresh Co')));
    expect(repeatDealKeyOf(deal, 3)).not.toBe(
      dealKeyOf('big deal', CO('Fresh Co'), contactNameKey('cy lee', CO('Fresh Co|repeat:3'))),
    );
    // Quotes and brackets are escaped, not interpreted.
    expect(CO('a","name')).not.toBe(CO('a'));
    expect(JSON.parse(CO('["x"]'))).toEqual(['name', '["x"]']);
  });

  it('a crafted file: two different contacts are not taken for one', () => {
    // "bo x|name:acme" at Zed and "bo x" at "acme|name:zed" shared a key: the second row was
    // refused as "an existing contact under another company".
    const p = buildPreview(
      bytes(
        'Company,Contact First Name,Contact Last Name,Owner Email\n' +
          'Zed,Bo,X|name:acme,owner.one@pravshi.example\n' +
          'acme|name:zed,Bo,X,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
      DEFAULT_LIMITS,
    );
    expect(p.invalidRows).toEqual([]);
    expect(outcomes(p)).toEqual([
      [2, 'CREATE', 'CREATE', null],
      [3, 'CREATE', 'CREATE', null],
    ]);
  });

  it('a decision on one deal never applies to a different deal with a look-alike key', () => {
    // Row 3's title holds what used to be row 2's company part: under "|" keys both rows were
    // one deal, so row 3 was flagged as its repeat. Now they are two deals, neither flagged.
    const p = buildPreview(
      bytes(
        'Company,Deal Title,Owner Email\n' +
          'acme|name:b,T,owner.one@pravshi.example\n' +
          'B,T|name:acme,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
      DEFAULT_LIMITS,
    );
    expect(p.unresolved.deals).toEqual([]);
    expect(p.counts.deals).toEqual({ create: 2, link: 0, possibleDuplicate: 0 });
  });
});
