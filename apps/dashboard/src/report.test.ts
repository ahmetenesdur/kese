/**
 * The spend report.
 *
 * "Privacy from the world, not from you" is the product's own claim, and this is where it is
 * honoured: the owner exports what the agent spent, for an accountant or an auditor.
 *
 * The report opens in a spreadsheet, which changes the threat model. A cell beginning `=`, `+`,
 * `-` or `@` is a FORMULA in Excel, Sheets and LibreOffice — and the memo field is written by an
 * LLM, which in turn may be repeating text from whoever asked it to make a payment. So a payment
 * request is a delivery vehicle for a formula that runs on the owner's machine when they open their
 * own accounts. That is the case these tests care most about.
 */

import { describe, expect, it } from "vitest";
import { toCsv, type ReportRow } from "./report.js";

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  at: "2026-08-21T09:15:00.000Z",
  source: "policy",
  kind: "private_transfer",
  amount: "2.5",
  symbol: "STRK",
  counterparty: "0x0b0b",
  outcome: "allow",
  visibility: "private",
  ...over,
});

describe("toCsv", () => {
  it("writes a header and one line per entry", () => {
    const lines = toCsv([row(), row()]).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("timestamp");
  });

  it("keeps amounts in whole tokens", () => {
    expect(toCsv([row({ amount: "2.5" })])).toContain("2.5");
  });

  it("records refusals, which are the reason an audit trail exists", () => {
    const csv = toCsv([row({ outcome: "deny", reason: "per_tx_cap_exceeded" })]);
    expect(csv).toContain("deny");
    expect(csv).toContain("per_tx_cap_exceeded");
  });
});

describe("spreadsheet formula injection", () => {
  // A memo is written by an LLM, which may be echoing text from whoever requested the payment.
  // Every one of these opens as a live formula if it is written out unchanged.
  for (const payload of [
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '=HYPERLINK("http://evil.example","Click")',
    '=cmd|\' /C calc\'!A0',
  ]) {
    it(`neutralises a memo beginning with ${payload.slice(0, 3)}`, () => {
      const cell = fieldFor(toCsv([row({ memo: payload })]), "memo");
      expect(cell.startsWith("=")).toBe(false);
      expect(cell.startsWith("+")).toBe(false);
      expect(cell.startsWith("-")).toBe(false);
      expect(cell.startsWith("@")).toBe(false);
      // Neutralised, not deleted — the owner still needs to see what was written.
      expect(cell).toContain(payload.slice(1, 6));
    });
  }

  it("leaves an ordinary memo untouched", () => {
    expect(fieldFor(toCsv([row({ memo: "invoice 4471" })]), "memo")).toBe("invoice 4471");
  });

  it("also guards a counterparty, which is caller-supplied too", () => {
    const cell = fieldFor(toCsv([row({ counterparty: "=1+1" })]), "counterparty");
    expect(cell.startsWith("=")).toBe(false);
  });
});

describe("csv escaping", () => {
  it("quotes a field containing a comma", () => {
    expect(toCsv([row({ memo: "hosting, monthly" })])).toContain('"hosting, monthly"');
  });

  it("doubles quotes inside a field", () => {
    expect(toCsv([row({ memo: 'the "big" one' })])).toContain('"the ""big"" one"');
  });

  it("quotes a field containing a newline rather than breaking the row", () => {
    const csv = toCsv([row({ memo: "line one\nline two" })]);
    expect(csv.trim().split("\n").filter((l) => l.includes("private_transfer"))).toHaveLength(1);
  });

  it("writes an empty cell for a missing optional field", () => {
    expect(fieldFor(toCsv([row({ memo: undefined })]), "memo")).toBe("");
  });
});

/** Read one named column out of a single-row CSV, undoing the quoting. */
function fieldFor(csv: string, column: string): string {
  const [header, line] = csv.trim().split("\n");
  const index = splitCsvLine(header!).indexOf(column);
  return splitCsvLine(line!)[index] ?? "";
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}
