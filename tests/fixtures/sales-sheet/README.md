# Representative Sales Sheet fixture — NOT the real sheet

`representative.csv` is a stand-in built for the BP-06 import scaffolding
(`src/lib/import/sales-sheet/`), matching `REPRESENTATIVE_MAPPING` in `mapping.ts`. The real
Sales Sheet's columns are not recorded in this repository (proposal §7), so **validation against
the actual sheet is pending** and the mapping must be replaced by the approved one before use.

Every row exercises one acceptance criterion of the proposal:

| Row | Purpose                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------- |
| 2   | Valid company + contact + deal; a thousands-separated amount; a lower-case stage; `50%`               |
| 3   | Same company domain as row 2 → created once, linked (AC-D4)                                           |
| 4   | Company domain and contact email already in the organization → linked (AC-D1, AC-D2)                  |
| 5   | Company without a domain whose name exists → possible duplicate (AC-D1)                               |
| 6   | RFC 4180 quoting: a comma in a value, a newline inside a value, doubled quotes; `in`/`usd` normalised |
| 7   | An ambiguous date `03/04/2026` → refused, never guessed (AC-F4)                                       |
| 8   | A stage outside the CRM's six → refused (AC-P2)                                                       |
| 9   | An owner who is not an active person of the organization → refused (AC-P4)                            |
| 10  | A formula-looking company name → kept as text; escaped in the failed-rows export (AC-C4)              |
| 11  | A probability above 100 → refused                                                                     |

The file starts with a UTF-8 byte-order mark (AC-F1) and has one unknown column, `Notes Column`,
which is listed and ignored (AC-F3). No real person, company or e-mail address is used: every domain
is under `example`.
