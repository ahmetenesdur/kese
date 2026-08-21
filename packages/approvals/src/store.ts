/**
 * Ticket persistence.
 *
 * The point is not history, it is recovery: a restart mid-approval loses the promise `spend()` was
 * awaiting, but NOT the policy reservation that approval was holding. Without a record of which
 * reservation belonged to which pending ticket, that budget stays held until the rolling 24h window
 * slides past it — invisibly, because nothing failed.
 */

import { DatabaseSync } from "node:sqlite";
import type { ApprovalPersistence } from "./channel.js";
import type { ApprovalVerdict } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_tickets (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT    NOT NULL,
  summary        TEXT    NOT NULL,
  reason         TEXT    NOT NULL,
  state          TEXT    NOT NULL CHECK (state IN ('pending','approved','denied','timeout','unreachable')),
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);
CREATE INDEX IF NOT EXISTS approval_pending ON approval_tickets (state);
`;

export function createApprovalStore(dbPath: string, now = () => Date.now()): ApprovalPersistence {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  return {
    async put(ticket) {
      db.prepare(
        "INSERT OR REPLACE INTO approval_tickets (id, reservation_id, summary, reason, state, created_at)" +
          " VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(ticket.id, ticket.reservationId, ticket.summary, ticket.reason, now());
    },

    async resolve(ticketId: string, state: ApprovalVerdict) {
      db.prepare(
        "UPDATE approval_tickets SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'"
      ).run(state, now(), ticketId);
    },

    async pending() {
      // SQLite hands back snake_case columns; the interface speaks camelCase. Mapping explicitly
      // rather than casting — a cast here compiles and then silently yields `undefined`
      // reservation ids, which is precisely the recovery this table exists to make possible.
      const rows = db
        .prepare("SELECT id, reservation_id FROM approval_tickets WHERE state = 'pending'")
        .all() as unknown as { id: string; reservation_id: string }[];
      return rows.map((row) => ({ id: row.id, reservationId: row.reservation_id }));
    },
  };
}
