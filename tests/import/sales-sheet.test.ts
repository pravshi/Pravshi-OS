/**
 * BP-06 Sales Sheet import — the database-free core, against the REPRESENTATIVE fixture
 * (tests/fixtures/sales-sheet/README.md). The real sheet's mapping is pending; these tests prove
 * parsing, mapping, validation, duplicate classification, the preview and the failed-rows export.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ImportFileError, parseCsv } from '@/lib/import/sales-sheet/csv';
import { REPRESENTATIVE_MAPPING, resolveHeader } from '@/lib/import/sales-sheet/mapping';
import { strictIsoDate } from '@/lib/import/sales-sheet/rows';
import {
  ImportRefusal,
  buildPreview,
  failedRowsCsv,
  normaliseKey,
  type OrgSnapshot,
} from '@/lib/import/sales-sheet/preview';

const FIXTURE = readFileSync('tests/fixtures/sales-sheet/representative.csv');
const OWNER_1 = '11111111-1111-4111-8111-111111111111';
const OWNER_2 = '22222222-2222-4222-8222-222222222222';
const snapshot = (over: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  companyDomains: new Set(['existing.example']),
  companyNames: new Set([normaliseKey('Name Only Ltd')]),
  contactEmails: new Map([['known@existing.example', 'domain:existing.example']]),
  contactNameCompany: new Set(),
  companyIdsByName: new Map([
    [normaliseKey('Name Only Ltd'), ['c0000000-0000-4000-8000-000000000001']],
  ]),
  contactIdsByNameCompany: new Map(),
  dealKeys: new Set(),
  activeOwnersByEmail: new Map([
    ['owner.one@pravshi.example', OWNER_1],
    ['owner.two@pravshi.example', OWNER_2],
  ]),
  completedFileHashes: new Set(),
  ...over,
});
const bytes = (s: string) => new TextEncoder().encode(s);

describe('CSV reading (AC-F1, AC-F2)', () => {
  it('reads RFC 4180 quoting: commas, newlines and doubled quotes inside values; a BOM', () => {
    const parsed = parseCsv(new TextDecoder().decode(FIXTURE));
    expect(parsed.header[0]).toBe('Company');
    const row6 = parsed.rows.find((r) => r.rowNumber === 6)!;
    expect(row6.values[0]).toBe('Quoted, Comma Pvt');
    expect(row6.values[2]).toBe('Multi\nline industry');
    expect(row6.values[9]).toBe('Deal with "quotes"');
    expect(parsed.rows).toHaveLength(10);
  });

  it('refuses an unterminated quote, an empty file and too many rows', () => {
    expect(() => parseCsv('a,b\n"x,1\n')).toThrow(ImportFileError);
    expect(() => parseCsv('')).toThrow(/no header/);
    expect(() => parseCsv('h\n1\n2\n3\n', { maxBytes: 1000, maxRows: 2 })).toThrow(/more than 2/);
  });

  it('refuses a file over the byte limit before reading a row, and invalid UTF-8', () => {
    expect(() =>
      buildPreview(bytes('Company\nX\n'), REPRESENTATIVE_MAPPING, snapshot(), {
        maxBytes: 4,
        maxRows: 10,
      }),
    ).toThrow(ImportRefusal);
    expect(() =>
      buildPreview(new Uint8Array([0x43, 0xff, 0x0a]), REPRESENTATIVE_MAPPING, snapshot()),
    ).toThrow(/not valid UTF-8/);
  });
});

describe('header mapping (AC-F3)', () => {
  it('matches trimmed, case-folded headers; lists unknown columns', () => {
    const r = resolveHeader(['  COMPANY ', 'owner email', 'Notes Column'], REPRESENTATIVE_MAPPING);
    expect(r.index.companyName).toBe(0);
    expect(r.index.ownerEmail).toBe(1);
    expect(r.unknownHeaders).toEqual(['Notes Column']);
    expect(r.missingRequired).toEqual([]);
  });

  it('refuses the whole file when a required column is missing, or a column repeats', () => {
    expect(() =>
      buildPreview(bytes('Company\nAcme\n'), REPRESENTATIVE_MAPPING, snapshot()),
    ).toThrow(/required columns are missing: Owner Email/);
    expect(() =>
      buildPreview(
        bytes('Company,company,Owner Email\nA,B,x@y.z\n'),
        REPRESENTATIVE_MAPPING,
        snapshot(),
      ),
    ).toThrow(/more than once/);
  });
});

describe('the preview of the representative fixture (AC-P1 … AC-D5)', () => {
  const p = buildPreview(FIXTURE, REPRESENTATIVE_MAPPING, snapshot());
  const valid = (n: number) => p.validRows.find((r) => r.rowNumber === n);
  const invalid = (n: number) => p.invalidRows.find((r) => r.rowNumber === n);

  it('accounts for every data row exactly once, and lists the unknown column', () => {
    expect(p.dataRows).toBe(10);
    expect(p.validRows.length + p.invalidRows.length).toBe(10);
    expect(p.unknownHeaders).toEqual(['Notes Column']);
    expect(p.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a company once and links the second row with the same domain (AC-D4)', () => {
    expect(valid(2)).toMatchObject({ company: 'CREATE', contact: 'CREATE', deal: 'CREATE' });
    expect(valid(3)).toMatchObject({ company: 'LINK', contact: 'CREATE', deal: 'CREATE' });
  });

  it('links to an existing company by domain and contact by email, modifying neither (AC-D1, AC-D2, AC-D5)', () => {
    expect(valid(4)).toMatchObject({
      company: 'LINK',
      contact: 'LINK',
      deal: null,
      ownerPersonId: OWNER_2,
    });
  });

  it('reports a name-only match as a possible duplicate, not a create (AC-D1)', () => {
    expect(valid(5)).toMatchObject({ company: 'POSSIBLE_DUPLICATE' });
  });

  it('normalises codes and keeps quoted values intact', () => {
    expect(valid(6)).toMatchObject({ company: 'CREATE', contact: 'CREATE', deal: 'CREATE' });
  });

  it('never guesses an ambiguous date (AC-F4)', () => {
    expect(invalid(7)!.errors).toEqual([
      { rowNumber: 7, column: 'Expected Close', reason: 'must be a real date written YYYY-MM-DD' },
    ]);
    expect(strictIsoDate('2026-02-30')).toBe(false);
    expect(strictIsoDate('2026-02-28')).toBe(true);
  });

  it("applies the CRM's own rules: a stage outside the six is refused (AC-P2)", () => {
    expect(invalid(8)!.errors.map((e) => e.column)).toEqual(['Stage']);
  });

  it('resolves owners only among the organization’s active people (AC-P4)', () => {
    expect(invalid(9)!.errors).toEqual([
      {
        rowNumber: 9,
        column: 'Owner Email',
        reason: 'is not an active person of this organization',
      },
    ]);
  });

  it('keeps a formula-looking value as plain text in the preview', () => {
    expect(valid(10)).toMatchObject({ company: 'CREATE' });
  });

  it('refuses a probability above 100', () => {
    expect(invalid(11)!.errors.map((e) => e.column)).toEqual(['Probability']);
  });

  it('counts per table: create, link, possible duplicate', () => {
    expect(p.counts.companies).toEqual({ create: 3, link: 2, possibleDuplicate: 1 });
    expect(p.counts.contacts).toEqual({ create: 3, link: 1, possibleDuplicate: 0 });
    expect(p.counts.deals).toEqual({ create: 3, link: 0, possibleDuplicate: 0 });
  });

  it('flags a file this organization already imported (AC-I1)', () => {
    const again = buildPreview(
      FIXTURE,
      REPRESENTATIVE_MAPPING,
      snapshot({ completedFileHashes: new Set([p.fileSha256]) }),
    );
    expect(again.alreadyImported).toBe(true);
    expect(p.alreadyImported).toBe(false);
  });

  it("is scoped to the snapshot's organization: another organization's owners never resolve", () => {
    const other = buildPreview(
      FIXTURE,
      REPRESENTATIVE_MAPPING,
      snapshot({ activeOwnersByEmail: new Map() }),
    );
    expect(other.validRows).toEqual([]);
  });
});

describe('what the preview hands to the stored import (0081)', () => {
  const HEADER =
    'Company,Company Domain,Contact First Name,Contact Last Name,Deal Title,Owner Email\n';

  it('reports a deal repeated within the file as a possible duplicate (AC-D3)', () => {
    const p = buildPreview(
      bytes(
        HEADER +
          'Acme,acme.example,Asha,Rao,Renewal,owner.one@pravshi.example\n' +
          'Acme,acme.example,Asha,Rao,renewal ,owner.one@pravshi.example\n' +
          'Acme,acme.example,Asha,Rao,Upsell,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
    );
    expect(p.validRows.map((r) => r.deal)).toEqual(['CREATE', 'POSSIBLE_DUPLICATE', 'CREATE']);
  });

  it('carries each row’s within-file keys and its values as the file had them', () => {
    const p = buildPreview(
      bytes(HEADER + 'Acme , ACME.example,Asha,Rao,,owner.one@pravshi.example\n'),
      REPRESENTATIVE_MAPPING,
      snapshot(),
    );
    expect(p.header).toEqual(HEADER.trim().split(','));
    expect(p.validRows[0]).toMatchObject({
      companyKey: 'domain:acme.example',
      contactKey: 'name:asha rao|domain:acme.example',
      values: ['Acme ', ' ACME.example', 'Asha', 'Rao', '', 'owner.one@pravshi.example'],
    });
  });

  it('reports every row naming a possible-duplicate company, not only the first (AC-D1)', () => {
    const p = buildPreview(
      bytes(
        'Company,Owner Email\n' +
          'Name Only Ltd,owner.one@pravshi.example\n' +
          'name only  ltd,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
    );
    expect(p.validRows.map((r) => r.company)).toEqual(['POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE']);
    expect(p.counts.companies).toEqual({ create: 0, link: 0, possibleDuplicate: 2 });
  });

  it('does not count a deferred row as something later rows link to (AC-D4)', () => {
    // Row 2 is a possible duplicate only through its deal; skipped by default, it creates no
    // company, so row 3 — the first committing row of that company — creates it.
    const p = buildPreview(
      bytes(
        HEADER +
          'Acme,acme.example,Asha,Rao,Renewal,owner.one@pravshi.example\n' +
          'Acme,acme.example,Ben,Roy,Upsell,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot({
        dealKeys: new Set(['renewal|domain:acme.example|name:asha rao|domain:acme.example']),
      }),
    );
    expect(p.validRows.map((r) => [r.company, r.deal])).toEqual([
      ['CREATE', 'POSSIBLE_DUPLICATE'],
      ['CREATE', 'CREATE'],
    ]);
    // The counts are what a commit with nothing included does: row 2 counts only its possible
    // duplicate; one company, one contact and one deal are created (by row 3).
    expect(p.counts).toEqual({
      companies: { create: 1, link: 0, possibleDuplicate: 0 },
      contacts: { create: 1, link: 0, possibleDuplicate: 0 },
      deals: { create: 1, link: 0, possibleDuplicate: 1 },
    });
  });

  it('reports a possible duplicate that would fail if included as not includable (S-1)', () => {
    // Including it would create a second "Name Only Ltd" and then meet bob under the first.
    const p = buildPreview(
      bytes(
        'Company,Contact First Name,Contact Last Name,Contact Email,Owner Email\n' +
          'Name Only Ltd,Bob,Lee,bob@x.example,owner.one@pravshi.example\n' +
          'Name Only Ltd,Cy,Lee,cy@x.example,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot({ contactEmails: new Map([['bob@x.example', 'name:name only ltd']]) }),
    );
    expect(p.validRows.map((r) => [r.company, r.contact])).toEqual([
      ['POSSIBLE_DUPLICATE', 'LINK'],
      ['POSSIBLE_DUPLICATE', 'CREATE'],
    ]);
    expect(p.notIncludableRows).toEqual([2]);
  });

  it('makes a contact that already belongs to another company a row error (AC-D2)', () => {
    const csv =
      'Company,Company Domain,Contact First Name,Contact Last Name,Contact Email,Owner Email\n';
    const existing = buildPreview(
      bytes(
        csv + 'Other,other.example,Old,Contact,known@existing.example,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
    );
    expect(existing.validRows).toEqual([]);
    expect(existing.invalidRows[0]!.errors[0]!.reason).toBe(
      'belongs to an existing contact under another company, or under none',
    );
    const inFile = buildPreview(
      bytes(
        csv +
          'One,one.example,Ann,Ray,ann@x.example,owner.one@pravshi.example\n' +
          'Two,two.example,Ann,Ray,ann@x.example,owner.one@pravshi.example\n' +
          'One,one.example,Ann,Ray,ann@x.example,owner.one@pravshi.example\n',
      ),
      REPRESENTATIVE_MAPPING,
      snapshot(),
    );
    expect(inFile.invalidRows.map((r) => r.rowNumber)).toEqual([3]);
    expect(inFile.validRows.map((r) => r.contact)).toEqual(['CREATE', 'LINK']);
  });

  it('refuses a file wider than the stored import allows', () => {
    const wide = `${Array.from({ length: 201 }, (_, i) => `C${i}`).join(',')}\n`;
    expect(() => buildPreview(bytes(wide), REPRESENTATIVE_MAPPING, snapshot())).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_COLUMNS' }),
    );
    const wideRow = `Company,Owner Email\nAcme,o@x.example${',x'.repeat(200)}\n`;
    expect(() => buildPreview(bytes(wideRow), REPRESENTATIVE_MAPPING, snapshot())).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_COLUMNS' }),
    );
  });
});

describe('failed-rows export (AC-C4)', () => {
  it('escapes anything a spreadsheet could execute, and quotes every field', () => {
    const csv = failedRowsCsv(
      ['Company', 'Owner Email'],
      [
        {
          rowNumber: 9,
          values: ['=HYPERLINK("http://x")', '+cmd'],
          errors: [{ rowNumber: 9, column: 'Owner Email', reason: 'is not an active person' }],
        },
        {
          rowNumber: 12,
          values: ['-1', '@SUM(A1)'],
          errors: [{ rowNumber: 12, column: null, reason: 'bad' }],
        },
      ],
    );
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('"Row","Company","Owner Email","Errors"');
    expect(lines[1]).toBe(
      `"9","'=HYPERLINK(""http://x"")","'+cmd","Owner Email: is not an active person"`,
    );
    expect(lines[2]).toBe(`"12","'-1","'@SUM(A1)","bad"`);
  });
});
