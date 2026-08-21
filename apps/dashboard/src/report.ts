/**
 * The spend report.
 *
 * "Privacy from the world, not from you" is the product's claim, and this is where it is honoured:
 * the owner exports what the agent spent, for an accountant or an auditor.
 *
 * **The report opens in a spreadsheet, and that changes the threat model.** A cell beginning with
 * `=`, `+`, `-` or `@` is a *formula* in Excel, Sheets and LibreOffice. The memo field is written by
 * an LLM, which may in turn be repeating text supplied by whoever asked it to make a payment. So a
 * payment request is a delivery vehicle for a formula that runs on the owner's own machine, at the
 * moment they open their own accounts — and nothing about the payment needs to succeed for the memo
 * to reach the file, because refused attempts are recorded too.
 *
 * Every caller-supplied field is therefore neutralised, not just escaped. Escaping solves commas
 * and quotes; it does nothing about formulas.
 */

export interface ReportRow {
  at: string;
  source: "policy" | "chain";
  kind: string;
  amount: string;
  symbol: string;
  counterparty?: string;
  outcome: string;
  reason?: string;
  visibility: string;
  memo?: string;
  reference?: string;
}

const COLUMNS = [
  "timestamp",
  "source",
  "action",
  "amount",
  "token",
  "counterparty",
  "outcome",
  "reason",
  "visibility",
  "memo",
  "reference",
] as const;

/** The characters a spreadsheet treats as the start of a formula. */
const FORMULA_STARTS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Make a value safe to open in a spreadsheet.
 *
 * A leading apostrophe is the conventional fix: spreadsheets treat it as "this is text", show the
 * rest verbatim, and strip it on display. The value stays readable — the owner still needs to see
 * exactly what was written, since a memo that tried to inject a formula is precisely the thing they
 * would want to notice.
 */
function neutralise(value: string): string {
  return FORMULA_STARTS.some((c) => value.startsWith(c)) ? `'${value}` : value;
}

/** RFC 4180 quoting: only for the delimiter, quotes and newlines. */
function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cell(value: string | undefined, callerSupplied = false): string {
  if (value === undefined || value === "") return "";
  return quote(callerSupplied ? neutralise(value) : value);
}

export function toCsv(rows: readonly ReportRow[]): string {
  const lines = [COLUMNS.join(",")];

  for (const row of rows) {
    lines.push(
      [
        cell(row.at),
        cell(row.source),
        cell(row.kind),
        cell(row.amount),
        cell(row.symbol),
        // Caller-supplied: an address the agent was told to pay, and a note it was told to write.
        cell(row.counterparty, true),
        cell(row.outcome),
        cell(row.reason),
        cell(row.visibility),
        cell(row.memo, true),
        cell(row.reference, true),
      ].join(",")
    );
  }

  // Trailing newline: some tools drop the final row without it.
  return `${lines.join("\n")}\n`;
}
