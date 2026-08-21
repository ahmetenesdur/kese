import { createHash, randomUUID } from "node:crypto";
import { PolicyStore, tryNormalizeAddress } from "./store.js";
import type {
  Decision,
  DecisionLogEntry,
  DenyCode,
  PaymentRequest,
  PolicyConfig,
  PolicyEngine,
} from "./types.js";

export interface PolicyEngineOptions {
  /** SQLite file path, or ":memory:" for tests. */
  dbPath: string;
  /** Injectable clock (ms since epoch) so window-boundary tests are deterministic. */
  now?: () => number;
}

function deny(code: DenyCode, reason: string): Decision {
  return { kind: "deny", code, reason };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fingerprint of what a request actually asks for, ignoring the idempotency key itself.
 *
 * This is what makes replay safe in the dangerous direction: an agent that retries the same key
 * with a bigger amount gets refused rather than handed the stored "allow". Addresses are
 * normalized first so re-writing one in padded form is not mistaken for a different request.
 */
function hashRequest(req: PaymentRequest): string {
  const canonical = JSON.stringify({
    agentId: req.agentId,
    kind: req.kind,
    token: tryNormalizeAddress(req.token),
    amount: req.amount.toString(10),
    recipient: req.recipient ? tryNormalizeAddress(req.recipient) : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Look a token up in a config map by address VALUE, not by string key.
 *
 * Config is hand-written and requests come from an LLM, so the same token can arrive written two
 * ways. Plain `record[token]` would miss a zero-padded address and fall through to
 * `token_not_configured` — a confusing denial for a token that is, in fact, configured.
 */
function lookupByAddress<T>(record: Record<string, T>, token: string): T | undefined {
  const wanted = tryNormalizeAddress(token);
  if (wanted === null) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (tryNormalizeAddress(key) === wanted) return value;
  }
  return undefined;
}

/**
 * The deterministic policy core (CLAUDE.md hard rule 2 — nothing reaches money except through here).
 *
 * Check order is deliberate, cheapest and most absolute first:
 *   validate → allowlist → token configured → per-tx cap → approval threshold
 * A cap is a ceiling, not a prompt: an amount over `perTxCap` is denied outright and never becomes
 * an approval request (docs/decisions.md D-011).
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  const now = options.now ?? (() => Date.now());
  const store = new PolicyStore(options.dbPath);

  function evaluate(req: PaymentRequest, cfg: PolicyConfig): Decision {
    if (req.idempotencyKey.trim() === "") {
      return deny("invalid_request", "idempotency_key is required on every money-moving call");
    }
    if (req.amount <= 0n) {
      return deny("invalid_request", "amount must be positive");
    }
    // A claim link has no recipient by design — that is what makes it payable by a stranger.
    if (req.kind !== "claim_link" && !req.recipient) {
      return deny("invalid_request", `${req.kind} requires a recipient`);
    }

    // Parse addresses before anything else touches them. A hallucinated or truncated address from
    // an LLM must come back as a denial; an exception escaping decide() would be a tool crash, and
    // a crash is not a denial (hard rule 4).
    const token = tryNormalizeAddress(req.token);
    if (token === null) return deny("invalid_request", "token is not a valid address");

    const recipient = req.recipient ? tryNormalizeAddress(req.recipient) : null;
    if (req.recipient && recipient === null) {
      return deny("invalid_request", "recipient is not a valid address");
    }

    if (cfg.allowlist !== "any" && recipient) {
      const allowed = cfg.allowlist.map(tryNormalizeAddress).filter((a): a is string => a !== null);
      if (!allowed.includes(recipient)) {
        return deny("recipient_not_allowlisted", `recipient is not on the allowlist`);
      }
    }

    const perTxCap = lookupByAddress(cfg.perTxCap, req.token);
    const dailyCap = lookupByAddress(cfg.dailyCap, req.token);
    const threshold = lookupByAddress(cfg.approvalThreshold, req.token);
    if (perTxCap === undefined || dailyCap === undefined || threshold === undefined) {
      // Fail closed (hard rule 4): an unconfigured token is not an unlimited one.
      return deny("token_not_configured", `no policy configured for token ${req.token}`);
    }

    if (req.amount > perTxCap) {
      return deny(
        "per_tx_cap_exceeded",
        `amount exceeds the per-transaction cap (${perTxCap}) — caps are absolute and cannot be approved past`
      );
    }

    const at = now();

    // Read the window and write the reservation inside one transaction — see PolicyStore.
    const alreadyReserved = store.sumReservedSince(token, at - DAY_MS);
    if (alreadyReserved + req.amount > dailyCap) {
      return deny(
        "daily_cap_exceeded",
        `rolling 24h total would reach ${alreadyReserved + req.amount}, over the daily cap (${dailyCap})`
      );
    }

    const reservationId = randomUUID();
    store.insertReservation({
      id: reservationId,
      token,
      amount: req.amount,
      createdAt: at,
      state: "active",
    });

    if (req.amount > threshold) {
      return {
        kind: "needs_approval",
        ticketId: randomUUID(),
        reservationId,
        reason: `amount exceeds the approval threshold (${threshold})`,
      };
    }

    return { kind: "allow", reservationId };
  }

  return {
    async decide(req, cfg) {
      let decision: Decision;
      try {
        decision = store.transaction(() => {
          // Idempotency and reservation must commit together: a crash between them would leave a
          // reservation no replay can recognise, and the next retry would spend twice.
          if (req.idempotencyKey.trim() !== "") {
            const seen = store.getIdempotency(req.idempotencyKey);
            if (seen) {
              return seen.requestHash === hashRequest(req)
                ? (JSON.parse(seen.decisionJson) as Decision)
                : deny(
                    "idempotency_key_reused",
                    "this idempotency_key was already used for a different request"
                  );
            }
          }

          const fresh = evaluate(req, cfg);
          if (req.idempotencyKey.trim() !== "") {
            store.putIdempotency(req.idempotencyKey, hashRequest(req), JSON.stringify(fresh), now());
          }
          return fresh;
        });

        store.logDecision({
          at: now(),
          request: req,
          decision: decision.kind,
          code: decision.kind === "deny" ? decision.code : undefined,
        });
      } catch {
        // Fail closed (hard rule 4). The error is deliberately not surfaced: it can carry SQL and
        // file paths, and this value is headed for an LLM's context.
        return deny(
          "storage_unavailable",
          "policy storage is unavailable — refusing to authorise a payment we cannot record"
        );
      }
      return decision;
    },

    async commitReservation(reservationId, receiptJson) {
      store.transaction(() => {
        const reservation = store.getReservation(reservationId);
        if (!reservation) throw new Error(`reservation ${reservationId} not found`);
        // Retrying a commit after a network blip is normal; re-committing is a no-op.
        if (reservation.state === "committed") return;
        if (reservation.state === "released") {
          throw new Error(`reservation ${reservationId} was already released and cannot be committed`);
        }
        store.setReservationState(reservationId, "committed", receiptJson);
      });
    },

    async releaseReservation(reservationId) {
      store.transaction(() => {
        const reservation = store.getReservation(reservationId);
        if (!reservation) throw new Error(`reservation ${reservationId} not found`);
        if (reservation.state === "released") return;
        if (reservation.state === "committed") {
          // Handing budget back for money that already left the wallet would make the cap
          // under-count real spending for the rest of the window.
          throw new Error(`reservation ${reservationId} was already committed and cannot be released`);
        }
        store.setReservationState(reservationId, "released");
      });
    },

    async remainingDaily(token, cfg) {
      const normalized = tryNormalizeAddress(token);
      const dailyCap = lookupByAddress(cfg.dailyCap, token);
      if (normalized === null || dailyCap === undefined) return 0n;
      const used = store.sumReservedSince(normalized, now() - DAY_MS);
      return used >= dailyCap ? 0n : dailyCap - used;
    },

    async reservationOutcome(reservationId) {
      const reservation = store.getReservation(reservationId);
      if (!reservation) return null;
      return reservation.receipt === null
        ? { state: reservation.state }
        : { state: reservation.state, receiptJson: reservation.receipt };
    },

    async recentDecisions(limit = 50): Promise<DecisionLogEntry[]> {
      return store.readDecisions(limit).map((row) => ({
        at: row.at,
        idempotencyKey: row.key,
        agentId: row.agent_id,
        kind: row.kind as PaymentRequest["kind"],
        token: row.token,
        amount: BigInt(row.amount),
        recipient: row.recipient ?? undefined,
        decision: row.decision as Decision["kind"],
        code: (row.code ?? undefined) as DenyCode | undefined,
      }));
    },

    close() {
      store.close();
    },
  };
}
