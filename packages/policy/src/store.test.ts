/**
 * Storage-layer tests, focused on the one thing engine tests structurally cannot catch.
 *
 * Every other test in this package runs against `:memory:` — a database that never existed before
 * the test started, and therefore always has today's schema. That is precisely the case where
 * schema drift is invisible. These tests use a real file written with an *older* shape, because
 * upgrading is the only situation in which the bug they pin can happen.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyStore } from "./store.js";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "kese-store-"));
  dirs.push(dir);
  return join(dir, "policy.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * `decisions_log` exactly as it shipped before `memo` was added.
 *
 * Hardcoding a historical schema is normally a smell, but this one is safe by nature: it is a
 * record of what the past looked like, and the past does not change. A migration *list* would have
 * to be maintained forever; this is a fixture.
 */
const OLD_DECISIONS_LOG = `
CREATE TABLE decisions_log (
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

describe("opening a database written by an older version", () => {
  it("adds a column the running code expects", () => {
    const path = tempDbPath();
    const old = new DatabaseSync(path);
    old.exec(OLD_DECISIONS_LOG);
    old.close();

    new PolicyStore(path);

    const columns = new DatabaseSync(path)
      .prepare("PRAGMA table_info(decisions_log)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).toContain("memo");
  });

  it("can write a decision afterwards", () => {
    // The regression this whole file exists for. The missing column did not fail loudly at open
    // time — it failed on the first write, which `decide()` catches and turns into a denial. The
    // symptom was every payment refused as `storage_unavailable`, with the real cause discarded.
    const path = tempDbPath();
    const old = new DatabaseSync(path);
    old.exec(OLD_DECISIONS_LOG);
    old.close();

    const store = new PolicyStore(path);
    expect(() =>
      store.transaction(() => {
        store.logDecision({
          at: 1_700_000_000_000,
          request: {
            idempotencyKey: "k",
            agentId: "agent",
            kind: "private_transfer",
            token: "0x1",
            amount: 1n,
            recipient: "0x2",
            memo: "invoice #1042",
          },
          decision: "allow",
        });
      })
    ).not.toThrow();
  });

  it("preserves rows already in the table", () => {
    const path = tempDbPath();
    const old = new DatabaseSync(path);
    old.exec(OLD_DECISIONS_LOG);
    old
      .prepare(
        "INSERT INTO decisions_log (at, key, agent_id, kind, token, amount, decision) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(1, "old-key", "agent", "pay", "0x1", "5", "allow");
    old.close();

    new PolicyStore(path);

    const rows = new DatabaseSync(path).prepare("SELECT key, memo FROM decisions_log").all();
    expect(rows).toEqual([{ key: "old-key", memo: null }]);
  });

  it("is idempotent — reopening an already-current database changes nothing", () => {
    const path = tempDbPath();
    new PolicyStore(path);
    expect(() => new PolicyStore(path)).not.toThrow();
  });
});
