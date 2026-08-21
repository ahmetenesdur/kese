/**
 * The guarded spend pipeline — the only path from a tool call to money moving.
 *
 * Every MCP money tool funnels through `spend()`. Nothing calls `@kese/core` transfer functions
 * directly (CLAUDE.md hard rule 2), because a second path is a path that will eventually skip a
 * check. Keeping it in one function also means the reservation lifecycle can be reasoned about
 * once instead of at every call site.
 *
 * The invariant that matters most: **a reservation is always resolved** — committed on success,
 * released on every failure path, including ones nobody expects. A dangling reservation holds
 * budget with nothing to show for it and nothing to notice it, until the rolling 24h window slides
 * past hours later. That is why the whole execution phase sits inside a try/finally.
 */

import type { KeseWallet } from "@kese/core";
import type { ApprovalChannel } from "@kese/approvals";
import type { DenyCode, PaymentRequest, PolicyConfig, PolicyEngine } from "@kese/policy";

export type { ApprovalChannel };

export interface SpendDeps {
  policy: PolicyEngine;
  wallet: KeseWallet;
  config: PolicyConfig;
  /** Absent means no channel is configured — approvals then fail closed. */
  approvals?: ApprovalChannel;
  redact: (input: unknown) => string;
  /** Where a withdrawal's funds go. Required for `kind: "withdraw"`. */
  withdrawTo?: string;
}

export type SpendOutcome =
  | { status: "paid"; txHash?: string; blockNumber?: number; replayed?: boolean }
  /**
   * Compiled and checked against live pool state, but NOT submitted — no proving service is
   * configured. Kept distinct from "paid" on purpose: an LLM told a payment succeeded will go on to
   * tell the user the invoice is settled, and a dry run that lies is worse than no dry run.
   */
  | { status: "simulated"; reason: string }
  | { status: "denied"; code: DenyCode | "approval_unavailable"; reason: string }
  | { status: "failed"; reason: string };

/** Receipt shape persisted with a committed reservation, so a replay can return it verbatim. */
interface StoredReceipt {
  txHash?: string;
  blockNumber?: number;
}

export async function spend(req: PaymentRequest, deps: SpendDeps): Promise<SpendOutcome> {
  const { policy, wallet, config, approvals, redact } = deps;

  const decision = await policy.decide(req, config);

  if (decision.kind === "deny") {
    return { status: "denied", code: decision.code, reason: decision.reason };
  }

  const { reservationId } = decision;

  // Replay guard. `decide()` is idempotent over DECISIONS, so a retried key comes back here with
  // the original reservation — and without this check we would execute the payment a second time.
  // Hard rule 3 is about execution, not just about deciding.
  const prior = await policy.reservationOutcome(reservationId);
  if (prior?.state === "committed") {
    const receipt = parseReceipt(prior.receiptJson);
    return { status: "paid", ...receipt, replayed: true };
  }
  if (prior?.state === "released") {
    // The original attempt ran and failed. Re-running it would spend budget that was already
    // given back, so report the earlier outcome instead of quietly trying again.
    return { status: "failed", reason: "this payment was already attempted and failed" };
  }

  let resolved = false;
  try {
    if (decision.kind === "needs_approval") {
      const verdict = await askForApproval(req, decision, reservationId, deps);
      if (verdict !== "approved") {
        resolved = true;
        await policy.releaseReservation(reservationId);
        return {
          status: "denied",
          code: "approval_unavailable",
          reason: verdict.reason,
        };
      }
    }

    const receipt = await execute(req, wallet, deps);

    if (receipt.status === "failed") {
      resolved = true;
      await policy.releaseReservation(reservationId);
      // Redact again even though the wallet already did. This is the last boundary before an MCP
      // tool result, i.e. an LLM's context, and defence in depth here costs nothing — redaction is
      // idempotent, and any future caller that supplies its own wallet is covered too.
      return { status: "failed", reason: redact(receipt.error ?? "payment failed") };
    }

    if (receipt.status === "simulated") {
      // Nothing moved, so the budget must come back — holding it would make the caps drift away
      // from reality every time a dry run happens.
      resolved = true;
      await policy.releaseReservation(reservationId);
      return {
        status: "simulated",
        reason:
          "compiled and checked against the live pool, but NOT submitted — no proving service is " +
          "configured, so no funds moved (strk20-hackathon#147)",
      };
    }

    resolved = true;
    const stored: StoredReceipt = { txHash: receipt.txHash, blockNumber: receipt.blockNumber };
    await policy.commitReservation(reservationId, JSON.stringify(stored));
    return { status: "paid", ...stored };
  } catch (error) {
    return { status: "failed", reason: redact(error) };
  } finally {
    // Backstop for anything that threw before the explicit commit/release above — an unexpected
    // error must not leave budget held. Releasing an already-resolved reservation would throw, so
    // this only fires when nothing else did.
    if (!resolved) {
      await policy.releaseReservation(reservationId).catch(() => {
        /* nothing better to do here; the decision log already records the attempt */
      });
    }
  }
}

type ApprovalVerdict = "approved" | { reason: string };

/**
 * Ask a human. Every non-approval is a denial (hard rule 4): a channel that is missing, throwing
 * or silent must never be read as consent.
 */
async function askForApproval(
  req: PaymentRequest,
  decision: { ticketId: string; reason: string },
  reservationId: string,
  deps: SpendDeps
): Promise<ApprovalVerdict> {
  const { approvals, policy, config, redact } = deps;
  if (!approvals) {
    return {
      reason:
        "this payment needs human approval, but no approval channel is configured — refusing rather than assuming consent",
    };
  }

  try {
    // The reservation is already taken, so this figure is what remains AFTER this payment — which
    // is the number the owner actually needs in order to decide.
    const remaining = await policy.remainingDaily(req.token, config).catch(() => null);

    const verdict = await approvals.request({
      id: decision.ticketId,
      reservationId,
      summary: summarize(req),
      reason: decision.reason,
      remainingDailyBudget: remaining === null ? undefined : `${remaining} (base units)`,
    });
    if (verdict === "approved") return "approved";
    return {
      reason:
        verdict === "timeout"
          ? "approval request timed out — treated as a denial"
          : "the owner denied this payment",
    };
  } catch (error) {
    return { reason: `approval channel unavailable: ${redact(error)}` };
  }
}

function summarize(req: PaymentRequest): string {
  const target = req.recipient ? ` to ${req.recipient}` : " via claim link";
  return `${req.kind} of ${req.amount} (token ${req.token})${target}`;
}

async function execute(req: PaymentRequest, wallet: KeseWallet, deps: SpendDeps) {
  switch (req.kind) {
    case "private_transfer":
      if (!req.recipient) throw new Error("private_transfer requires a recipient");
      return wallet.payPrivate(req.token, req.amount, req.recipient);

    case "withdraw": {
      const to = req.recipient ?? deps.withdrawTo;
      if (!to) throw new Error("withdraw requires a destination address");
      return wallet.withdraw(req.token, req.amount, to);
    }

    case "claim_link":
      // Phase C. Failing here rather than silently doing something else keeps the tool honest.
      throw new Error(
        "claim links need the escrow contract, which is not deployed yet (ESCROW_CONTRACT_ADDRESS unset)"
      );
  }
}

function parseReceipt(json: string | undefined): StoredReceipt {
  if (!json) return {};
  try {
    return JSON.parse(json) as StoredReceipt;
  } catch {
    return {};
  }
}
