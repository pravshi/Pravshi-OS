/**
 * BP-06 Sales Sheet import — CSV reading (proposal AC-F1, AC-F2).
 *
 * One CSV file, UTF-8 (a byte-order mark is accepted), comma-separated, RFC 4180 quoting
 * (quoted fields may contain commas, newlines and doubled quotes), one header row. No
 * dependency: the format is small and fully specified, and a parser we own has no zip,
 * macro or formula surface. Limits are enforced before any row is processed.
 */

export interface ImportLimits {
  maxBytes: number;
  maxRows: number;
}

export const DEFAULT_LIMITS: ImportLimits = { maxBytes: 5 * 1024 * 1024, maxRows: 10_000 };

export type ImportFileErrorCode =
  'FILE_TOO_LARGE' | 'TOO_MANY_ROWS' | 'EMPTY_FILE' | 'UNTERMINATED_QUOTE' | 'NOT_UTF8';

export class ImportFileError extends Error {
  constructor(
    readonly code: ImportFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportFileError';
  }
}

export interface ParsedCsv {
  header: string[];
  /** Data rows, each with its 1-based line number in the sheet (header = row 1). */
  rows: { rowNumber: number; values: string[] }[];
}

/** Decodes bytes as strict UTF-8, refusing invalid sequences rather than guessing. */
export function decodeUtf8(bytes: Uint8Array, limits: ImportLimits = DEFAULT_LIMITS): string {
  if (bytes.byteLength > limits.maxBytes) {
    throw new ImportFileError(
      'FILE_TOO_LARGE',
      `The file is larger than ${limits.maxBytes} bytes.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportFileError('NOT_UTF8', 'The file is not valid UTF-8.');
  }
}

export function parseCsv(text: string, limits: ImportLimits = DEFAULT_LIMITS): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushRecord = () => {
    record.push(field);
    field = '';
    // A blank line (one empty field) is not a record.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
    if (records.length > limits.maxRows + 1) {
      throw new ImportFileError(
        'TOO_MANY_ROWS',
        `The file has more than ${limits.maxRows} data rows.`,
      );
    }
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      pushRecord();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new ImportFileError('UNTERMINATED_QUOTE', 'A quoted value is not closed.');
  }
  if (field !== '' || record.length > 0) pushRecord();
  if (records.length === 0) throw new ImportFileError('EMPTY_FILE', 'The file has no header row.');
  const [header, ...data] = records;
  return {
    header: header!,
    rows: data.map((values, index) => ({ rowNumber: index + 2, values })),
  };
}
