/**
 * Untrusted-content delimiting and escaping (Phase 9, Workstream D).
 *
 * Contract §7.5: every record is serialized inside a `<record_data>` block and
 * record-derived text is untrusted — it must never be able to forge a block
 * boundary, an attribute, or an instruction. The defence here is structural:
 * every `<` and `>` in a serialized value is entity-escaped, so the only raw
 * `<record_data …>` / `</record_data>` sequences in a built context are the
 * ones this module emitted. Tool results (Workstream E) are wrapped with the
 * same serializer so the model sees exactly one data format.
 */
import type { ProjectedRecord } from './types';

export const RECORD_DATA_TAG = 'record_data';

/**
 * Escape untrusted text for inclusion inside a `<record_data>` block.
 * Escapes the angle brackets (delimiter forgery becomes impossible, including
 * a literal `</record_data>` or `<record_data …>` inside a note), normalizes
 * line endings, and strips NUL bytes. The text remains fully readable to the
 * model — `&lt;` in a note summarises exactly like `<`.
 */
export function escapeRecordText(value: string): string {
  return value
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a value placed inside a double-quoted block attribute. Attribute
 * values are system-generated (entity names from a fixed union, uuid ids from
 * the database), but they are escaped anyway — the serializer never trusts
 * its inputs. */
function escapeAttribute(value: string): string {
  return escapeRecordText(value).replace(/"/g, '&quot;');
}

/** Shorten a string to at most `maxChars` characters (contract §7.3 caps). */
export function truncateChars(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

export interface SerializedBlock {
  readonly text: string;
  /** True when the label or any field value had to be shortened. */
  readonly fieldTruncated: boolean;
}

/**
 * Serialize one projected record as a delimited block:
 *
 *   <record_data entity="deal" id="…">
 *   label: <the record's label — always the first line>
 *   key: value
 *   …
 *   </record_data>
 *
 * The `label:` first line is a stable seam: the deterministic mock provider
 * (contract §3.3) reads the first record's label as the summary headline and
 * the remaining lines as candidate facts. Every value — label included — is
 * escaped and truncated to `maxFieldChars`.
 */
export function serializeRecordBlock(
  record: ProjectedRecord,
  maxFieldChars: number,
): SerializedBlock {
  let fieldTruncated = false;
  const renderValue = (raw: string): string => {
    const truncated = truncateChars(raw, maxFieldChars);
    if (truncated.length !== raw.length) fieldTruncated = true;
    return escapeRecordText(truncated);
  };

  const idAttribute =
    record.entityId !== undefined ? ` id="${escapeAttribute(record.entityId)}"` : '';
  const lines: string[] = [
    `<${RECORD_DATA_TAG} entity="${escapeAttribute(record.entityType)}"${idAttribute}>`,
    `label: ${renderValue(record.label)}`,
  ];
  for (const [key, value] of record.fields) {
    lines.push(`${key}: ${renderValue(value)}`);
  }
  lines.push(`</${RECORD_DATA_TAG}>`);
  return { text: lines.join('\n'), fieldTruncated };
}
