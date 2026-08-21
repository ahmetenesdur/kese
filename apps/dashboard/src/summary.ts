/**
 * What the owner sees.
 *
 * Two things have to be right here or the view quietly misleads:
 *
 * **Coverage.** Kese's decision log records everything the agent *attempted*, refusals included —
 * those never reach the chain and are exactly what an audit view is for. The chain records what
 * actually *settled*. Merging them keeps both, tagged by source, so a denied payment can never be
 * mistaken for a completed one.
 *
 * **Attribution.** On-chain shields are attributable to us because the pool's `Deposit` event
 * indexes the depositor. Withdrawals are not: the pool encrypts the initiator and indexes only the
 * recipient. So the chain half of this view is shields only, and the page has to say so rather than
 * under-report and look precise.
 */

import { describeAmount, formatTokenAmount, tokenSymbol, type Network, type ShieldEntry } from "@kese/core";
import type { DecisionLogEntry, PolicyConfig } from "@kese/policy";

export interface TokenPanel {
  token: string;
  symbol: string;
  /** Whole tokens, as a string — base units never reach a human surface. */
  shielded: string;
  dailyCap: string;
  dailyRemaining: string;
  perTxCap: string;
  approvalThreshold: string;
  /** 0–1, for a meter. */
  dailyUsedFraction: number;
}

export interface Summary {
  network: Network;
  tokens: TokenPanel[];
  allowlist: string[] | "any";
}

export interface SummaryInput {
  network: Network;
  balances: Record<string, bigint>;
  remainingDaily: Record<string, bigint>;
  config: PolicyConfig;
}

export function buildSummary(input: SummaryInput): Summary {
  const tokens = Object.keys(input.config.perTxCap).map((token): TokenPanel => {
    const cap = input.config.dailyCap[token] ?? 0n;
    const left = input.remainingDaily[token] ?? 0n;
    const used = cap > left ? cap - left : 0n;

    return {
      token,
      symbol: tokenSymbol(token, input.network),
      shielded: formatTokenAmount(input.balances[token] ?? 0n),
      dailyCap: formatTokenAmount(cap),
      dailyRemaining: formatTokenAmount(left),
      perTxCap: formatTokenAmount(input.config.perTxCap[token] ?? 0n),
      approvalThreshold: formatTokenAmount(input.config.approvalThreshold[token] ?? 0n),
      // A zero cap means "nothing budgeted", not "all spent" — and it must not produce NaN, which
      // would render as an empty meter and read as "plenty left".
      dailyUsedFraction: cap === 0n ? 0 : Number((used * 10_000n) / cap) / 10_000,
    };
  });

  return { network: input.network, tokens, allowlist: input.config.allowlist };
}

export interface ActivityEntry {
  at: number;
  /** `policy` = what the agent asked for. `chain` = what settled. */
  source: "policy" | "chain";
  kind: string;
  amount: string;
  symbol: string;
  counterparty?: string;
  /** What the payment was for. UNTRUSTED — an LLM writes it (see report.ts). */
  memo?: string;
  /** The verdict: allow / deny / needs_approval / settled. Drives colour. */
  outcome: string;
  /** Which rule fired, when there was one. Drives the explanation next to it. */
  reason?: string;
  /** Whether this step is visible on-chain to anyone. */
  /**
   * `amount-public` is its own case, not a shade of private: a claim link hides the recipient
   * but its value rides in an open note, in the clear.
   */
  visibility: "private" | "public" | "amount-public";
  reference?: string;
}

export interface ActivityInput {
  decisions: DecisionLogEntry[];
  shields: ShieldEntry[];
  network: Network;
}

/** The public edges of the pool: money entering or leaving is visible to anyone. */
const PUBLIC_KINDS = new Set(["withdraw", "shield"]);

/** Hides who, not how much — the escrow pays through an open note, which carries a plain amount. */
const AMOUNT_PUBLIC_KINDS = new Set(["claim_link"]);

function visibilityOf(kind: string): "private" | "public" | "amount-public" {
  if (PUBLIC_KINDS.has(kind)) return "public";
  if (AMOUNT_PUBLIC_KINDS.has(kind)) return "amount-public";
  return "private";
}

export function mergeActivity(input: ActivityInput): ActivityEntry[] {
  const fromPolicy = input.decisions.map((entry): ActivityEntry => ({
    at: entry.at,
    source: "policy",
    kind: entry.kind,
    amount: formatTokenAmount(entry.amount),
    symbol: tokenSymbol(entry.token, input.network),
    counterparty: entry.recipient,
    memo: entry.memo,
    // Both, deliberately. The verdict colours the row; the code explains it. Collapsing them into
    // one field forces the UI to choose between "is this bad" and "why", and it needs both.
    outcome: entry.decision,
    reason: entry.code,
    visibility: visibilityOf(entry.kind),
    reference: entry.idempotencyKey,
  }));

  const fromChain = input.shields.map((shield): ActivityEntry => ({
    // Block number is not a timestamp, but it orders correctly against nothing else here; the page
    // shows the block rather than pretending to know the wall-clock time.
    at: (shield.blockNumber ?? 0) * 1000,
    source: "chain",
    kind: "shield",
    amount: formatTokenAmount(shield.amount),
    symbol: tokenSymbol(shield.token, input.network),
    outcome: "settled",
    visibility: "public",
    reference: shield.transactionHash,
  }));

  return [...fromPolicy, ...fromChain].sort((a, b) => b.at - a.at);
}

/** One line for the top of the page. */
export function headline(summary: Summary): string {
  const funded = summary.tokens.filter((t) => t.shielded !== "0");
  if (funded.length === 0) return "Nothing shielded yet";
  return funded.map((t) => describeAmountFrom(t)).join(" · ");
}

function describeAmountFrom(panel: TokenPanel): string {
  return `${panel.shielded} ${panel.symbol}`;
}

export { describeAmount };
