/**
 * The decision, made visible.
 *
 * This mirrors the order `packages/policy/src/engine.ts` evaluates in — deliberately, because the
 * order *is* the design. Two things about it are opinions rather than mechanics, and both are on
 * the page precisely because a visitor would not guess them:
 *
 *   - The per-transaction cap is checked BEFORE the approval threshold. A cap is absolute: there
 *     is no dialog that lets an owner approve past it. Asking would imply the limit is a
 *     suggestion.
 *   - The daily figure is a ROLLING 24-hour window, not a calendar day. Midnight is not a budget.
 *
 * Every rule is returned every time, including the ones evaluation never reached. That is the
 * whole point of showing this: a gate that stops at the first failure is different from one that
 * collects reasons, and a visitor should be able to *see* the difference rather than read about it.
 *
 * It is a faithful restatement of the rules, not the engine itself — no wallet, no chain, no
 * network. The real engine also reserves against the window inside a database transaction, which
 * is what makes concurrent payments safe and is not something a page can show.
 */

export type Verdict = "allow" | "ask" | "deny";
export type RuleState = "pass" | "fail" | "ask" | "skipped";

export interface Rule {
  label: string;
  /** What the rule saw. Empty for a rule that was never reached. */
  detail: string;
  state: RuleState;
  /** The engine's own code, present only on the rule that refused. */
  code?: string;
  /** Present on the budget rule, so the page can draw it rather than describe it. */
  meter?: { spent: number; adding: number; cap: number };
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
  /** All five, in evaluation order. */
  rules: Rule[];
  /** Index of the rule that decided. */
  decidedAt: number;
  headline: string;
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");

export function decide(amount: number, policy: Policy): Decision {
  const wouldReach = policy.spentToday + amount;

  // Written out in full so the shape of the gate is visible in the source too, not just on screen.
  const rules: Rule[] = [
    {
      label: "Amount is a positive number",
      detail: amount > 0 ? `${fmt(amount)} STRK` : "must be greater than 0",
      state: "pass",
    },
    {
      label: "Recipient is on the allowlist",
      detail: policy.allowlisted ? "0x04b2…9c1a allowlisted" : "0x9f31…20de not allowlisted",
      state: "pass",
    },
    {
      label: "Per-transaction cap",
      detail: `${fmt(amount)} STRK · cap ${fmt(policy.perTxCap)}`,
      state: "pass",
    },
    {
      label: "Rolling 24-hour budget",
      detail: `${fmt(wouldReach)} of ${fmt(policy.dailyCap)} STRK if paid`,
      state: "pass",
      meter: { spent: policy.spentToday, adding: amount, cap: policy.dailyCap },
    },
    {
      label: "Approval threshold",
      detail: `${fmt(amount)} STRK · threshold ${fmt(policy.approvalThreshold)}`,
      state: "pass",
    },
  ];

  /** Stop here: mark this rule, blank everything after it, and answer. */
  const stopAt = (
    index: number,
    state: "fail" | "ask",
    verdict: Verdict,
    headline: string,
    code?: string
  ): Decision => {
    rules[index]!.state = state;
    rules[index]!.code = code;
    for (const later of rules.slice(index + 1)) {
      later.state = "skipped";
      later.detail = "";
      delete later.meter;
    }
    return { verdict, rules, decidedAt: index, headline };
  };

  if (!(amount > 0)) return stopAt(0, "fail", "deny", "Enter an amount greater than 0", "invalid_request");

  if (!policy.allowlisted) {
    return stopAt(1, "fail", "deny", "Recipient is not on the allowlist", "recipient_not_allowlisted");
  }

  if (amount > policy.perTxCap) {
    // Before the threshold on purpose: a cap is not something an owner can approve past.
    return stopAt(2, "fail", "deny", "Over the per-transaction cap. Caps are absolute", "per_tx_cap_exceeded");
  }

  if (wouldReach > policy.dailyCap) {
    return stopAt(3, "fail", "deny", "Would exceed the rolling 24-hour budget", "daily_cap_exceeded");
  }

  if (amount > policy.approvalThreshold) {
    return stopAt(4, "ask", "ask", "Above the approval threshold — Kese asks the owner on Telegram");
  }

  return {
    verdict: "allow",
    rules,
    decidedAt: 4,
    headline: "All policy checks passed — the agent pays privately",
  };
}
