/**
 * Claim-link records.
 *
 * Two secrets exist per link and their handling rules are opposites:
 *
 * - The **claim** secret is a bearer token for one payment. Handing it to the recipient is the
 *   agent's entire job, so it reaches the LLM once — and is stored nowhere. A stolen copy of this
 *   database gives an attacker no claim path, because the claim secret was never written down.
 * - The **refund** secret is the payer's, and it is the only route back to the funds after expiry.
 *   It must persist, and it must never leave the server.
 *
 * So this table holds exactly the half that has to survive a restart, and nothing more.
 */

import { DatabaseSync } from "node:sqlite";

export type ClaimState = "pending" | "claimed" | "refunded";

export interface ClaimRecord {
  idempotencyKey: string;
  commitmentHash: string;
  /** SERVER-SIDE ONLY. Never returned by a tool, never logged. */
  refundSecret: string;
  token: string;
  amount: bigint;
  expiryBlock: number;
  state?: ClaimState;
}

export interface ClaimStore {
  put(record: ClaimRecord): Promise<void>;
  byCommitment(commitmentHash: string): Promise<ClaimRecord | null>;
  byIdempotencyKey(key: string): Promise<ClaimRecord | null>;
  markSettled(commitmentHash: string, state: "claimed" | "refunded"): Promise<void>;
  /** Links past their expiry that nobody claimed — the payer's money, waiting. */
  refundableAt(block: number): Promise<ClaimRecord[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_links (
  commitment_hash TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  refund_secret   TEXT NOT NULL,
  token           TEXT NOT NULL,
  -- TEXT, not INTEGER: 10^18-scale amounts exceed Number.MAX_SAFE_INTEGER, and SQLite would
  -- coerce them through a float.
  amount          TEXT NOT NULL,
  expiry_block    INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','claimed','refunded')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_links_refundable ON claim_links (state, expiry_block);
`;

interface Row {
  commitment_hash: string;
  idempotency_key: string;
  refund_secret: string;
  token: string;
  amount: string;
  expiry_block: number;
  state: ClaimState;
}

function toRecord(row: Row): ClaimRecord {
  return {
    idempotencyKey: row.idempotency_key,
    commitmentHash: row.commitment_hash,
    refundSecret: row.refund_secret,
    token: row.token,
    amount: BigInt(row.amount),
    expiryBlock: row.expiry_block,
    state: row.state,
  };
}

export function createClaimStore(dbPath: string, now = () => Date.now()): ClaimStore {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  return {
    async put(record) {
      db.prepare(
        "INSERT OR REPLACE INTO claim_links" +
          " (commitment_hash, idempotency_key, refund_secret, token, amount, expiry_block, state, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
      ).run(
        record.commitmentHash,
        record.idempotencyKey,
        record.refundSecret,
        record.token,
        record.amount.toString(10),
        record.expiryBlock,
        now()
      );
    },

    async byCommitment(commitmentHash) {
      const row = db
        .prepare("SELECT * FROM claim_links WHERE commitment_hash = ?")
        .get(commitmentHash) as Row | undefined;
      return row ? toRecord(row) : null;
    },

    async byIdempotencyKey(key) {
      const row = db.prepare("SELECT * FROM claim_links WHERE idempotency_key = ?").get(key) as
        | Row
        | undefined;
      return row ? toRecord(row) : null;
    },

    async markSettled(commitmentHash, state) {
      db.prepare(
        "UPDATE claim_links SET state = ? WHERE commitment_hash = ? AND state = 'pending'"
      ).run(state, commitmentHash);
    },

    async refundableAt(block) {
      const rows = db
        .prepare(
          "SELECT * FROM claim_links WHERE state = 'pending' AND expiry_block <= ? ORDER BY expiry_block"
        )
        .all(block) as unknown as Row[];
      return rows.map(toRecord);
    },
  };
}
