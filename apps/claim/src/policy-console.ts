/**
 * The decision, made visible.
 *
 * This mirrors the order `packages/policy/src/engine.ts` evaluates in — deliberately, and in that
 * order, because the order *is* the design. Two things about it are opinions rather than
 * mechanics, and both are on the page precisely because a visitor would not guess them:
 *
 *   - The per-transaction cap is checked BEFORE the approval threshold. A cap is absolute: there
 *     is no dialog that lets an owner approve past it. Asking would imply the limit is a
 *     suggestion.
 *   - The daily figure is a ROLLING 24-hour window, not a calendar day. Midnight is not a budget.
 *
 * It is a faithful re-statement of the rules, not the engine itself — no wallet, no chain, no
 * network. The real engine additionally reserves against the window inside a database transaction,
 * which is what makes concurrent payments safe and is not something a page can show.
 */

export type Verdict = "allow" | "ask" | "deny";

export interface Rule {
  /** What the rule checks, in the reader's terms. */
  label: string;
  /** Filled in once the rule has been evaluated. */
  detail: string;
  passed: boolean;
  /** The engine's own code, shown when this is the rule that decided. */
  code?: string;
}

export interface Policy {
  perTxCap: number;
  dailyCap: number;
  approvalThreshold: number;
  spentToday: number;
  allowlisted: boolean;
}

export interface Decision {
  verdict: Verdict;
  /** Every rule, in evaluation order. Rules after the deciding one are never reached. */
  rules: Rule[];
  /** Index of the rule that decided. */
  decidedAt: number;
  headline: string;
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");

export function decide(amount: number, policy: Policy): Decision {
  const rules: Rule[] = [];
  const stop = (verdict: Verdict, headline: string, code?: string): Decision => {
    rules[rules.length - 1]!.passed = false;
    rules[rules.length - 1]!.code = code;
    return { verdict, rules, decidedAt: rules.length - 1, headline };
  };

  rules.push({
    label: "Amount is a positive number",
    detail: amount > 0 ? `${fmt(amount)} STRK` : "not a valid amount",
    passed: true,
  });
  if (!(amount > 0)) return stop("deny", "Not a valid amount", "invalid_request");

  rules.push({
    label: "Recipient is on the allowlist",
    detail: policy.allowlisted ? "0x04b2…9c1a is allowed" : "0x9f31…20de is not on the list",
    passed: true,
  });
  if (!policy.allowlisted) {
    return stop("deny", "Recipient is not on the allowlist", "recipient_not_allowlisted");
  }

  rules.push({
    label: "Per-transaction cap",
    detail: `${fmt(amount)} against a cap of ${fmt(policy.perTxCap)}`,
    passed: true,
  });
  if (amount > policy.perTxCap) {
    // Checked before the threshold on purpose: a cap is not something an owner can approve past.
    return stop("deny", "Over the per-transaction cap — and caps are absolute", "per_tx_cap_exceeded");
  }

  const wouldReach = policy.spentToday + amount;
  rules.push({
    label: "Rolling 24-hour budget",
    detail: `${fmt(policy.spentToday)} spent, this would reach ${fmt(wouldReach)} of ${fmt(policy.dailyCap)}`,
    passed: true,
  });
  if (wouldReach > policy.dailyCap) {
    return stop("deny", "Would exceed the rolling 24-hour budget", "daily_cap_exceeded");
  }

  rules.push({
    label: "Approval threshold",
    detail: `${fmt(amount)} against a threshold of ${fmt(policy.approvalThreshold)}`,
    passed: true,
  });
  if (amount > policy.approvalThreshold) {
    return {
      verdict: "ask",
      rules,
      decidedAt: rules.length - 1,
      headline: "Over the threshold — the owner gets a message",
    };
  }

  return {
    verdict: "allow",
    rules,
    decidedAt: rules.length - 1,
    headline: "Inside every limit — the agent pays, privately",
  };
}
