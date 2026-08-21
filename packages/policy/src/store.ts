/**
 * Policy state, on SQLite.
 *
 * Every method here is SYNCHRONOUS on purpose. The reserve path reads the current spend and writes
 * a reservation, and those two steps must not interleave with another payment's — hard rule 5. A
 * synchronous body cannot be interrupted by the event loop, and `BEGIN IMMEDIATE` extends the same
 * guarantee to a second process (the MCP server and the dashboard can both hold this file open).
 * Introducing an `await` inside a transaction here would silently reopen the race.
 *
 * Amounts are stored as decimal TEXT, not INTEGER: token amounts run at 10^18 scale, well past
 * Number.MAX_SAFE_INTEGER, and a silent precision loss in a spending limit is the worst possible
 * place for one. They are summed in JS as bigint rather than by SQL SUM().
 */

export { normalizeAddress, tryNormalizeAddress };
import { DatabaseSync } from "node:sqlite";
import { normalizeAddress, tryNormalizeAddress } from "@kese/core";
import type { DenyCode, PaymentRequest } from "./types.js";

export type ReservationState = "active" | "committed" | "released";

export interface ReservationRow {
  id: string;
  token: string;
  amount: bigint;
  createdAt: number;
  state: ReservationState;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
  id          TEXT PRIMARY KEY,
  token       TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  state       TEXT    NOT NULL CHECK (state IN ('active','committed','released')),
  receipt     TEXT
);
CREATE INDEX IF NOT EXISTS reservations_window ON reservations (token, created_at, state);

CREATE TABLE IF NOT EXISTS idempotency (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  key         TEXT    NOT NULL,
  agent_id    TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  token       TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  recipient   TEXT,
  decision    TEXT    NOT NULL,
  code        TEXT
);
`;

export class PolicyStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL keeps a reader (dashboard) from blocking the writer (MCP server).
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** Run `fn` inside an immediate transaction; roll back if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertReservation(row: ReservationRow): void {
    this.db
      .prepare(
        "INSERT INTO reservations (id, token, amount, created_at, state) VALUES (?, ?, ?, ?, ?)"
      )
      .run(row.id, row.token, row.amount.toString(10), row.createdAt, row.state);
  }

  /**
   * Total reserved for `token` in the window starting at `since` — active AND committed.
   *
   * Active must be included: that is what stops two concurrent payments from each seeing an empty
   * ledger and both fitting under the cap (hard rule 5). Released rows are excluded, which is what
   * gives a failed payment its budget back.
   *
   * Summed in JS as bigint rather than by SQL SUM(), because the amounts are TEXT — see the file
   * header. SUM() over TEXT would coerce to float and quietly lose precision at 10^18.
   */
  sumReservedSince(token: string, since: number): bigint {
    const rows = this.db
      .prepare(
        "SELECT amount FROM reservations" +
          " WHERE token = ? AND created_at >= ? AND state IN ('active','committed')"
      )
      .all(token, since) as { amount: string }[];
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }

  getReservation(id: string): { id: string; state: ReservationState } | null {
    const row = this.db.prepare("SELECT id, state FROM reservations WHERE id = ?").get(id) as
      | { id: string; state: ReservationState }
      | undefined;
    return row ?? null;
  }

  setReservationState(id: string, state: ReservationState, receipt?: string): void {
    this.db
      .prepare("UPDATE reservations SET state = ?, receipt = COALESCE(?, receipt) WHERE id = ?")
      .run(state, receipt ?? null, id);
  }

  getIdempotency(key: string): { requestHash: string; decisionJson: string } | null {
    const row = this.db
      .prepare("SELECT request_hash, decision_json FROM idempotency WHERE key = ?")
      .get(key) as { request_hash: string; decision_json: string } | undefined;
    return row ? { requestHash: row.request_hash, decisionJson: row.decision_json } : null;
  }

  putIdempotency(key: string, requestHash: string, decisionJson: string, at: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO idempotency (key, request_hash, decision_json, created_at)" +
          " VALUES (?, ?, ?, ?)"
      )
      .run(key, requestHash, decisionJson, at);
  }

  logDecision(entry: {
    at: number;
    request: PaymentRequest;
    decision: string;
    code?: DenyCode;
  }): void {
    this.db
      .prepare(
        "INSERT INTO decisions_log (at, key, agent_id, kind, token, amount, recipient, decision, code)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        entry.at,
        entry.request.idempotencyKey,
        entry.request.agentId,
        entry.request.kind,
        entry.request.token,
        entry.request.amount.toString(10),
        entry.request.recipient ?? null,
        entry.decision,
        entry.code ?? null
      );
  }

  readDecisions(limit: number): {
    at: number;
    key: string;
    agent_id: string;
    kind: string;
    token: string;
    amount: string;
    recipient: string | null;
    decision: string;
    code: string | null;
  }[] {
    return this.db
      .prepare("SELECT * FROM decisions_log ORDER BY id DESC LIMIT ?")
      .all(limit) as never;
  }

  close(): void {
    this.db.close();
  }
}
