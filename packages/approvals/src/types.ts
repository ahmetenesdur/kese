/** What the owner is being asked to approve. */
export interface ApprovalTicket {
  id: string;
  /** The policy reservation this approval unblocks — needed to release it on a restart. */
  reservationId: string;
  summary: string;
  /** Which policy rule required a human. Goes in the message verbatim. */
  reason: string;
  /** Human-readable budget left after this payment, so the decision has context. */
  remainingDailyBudget?: string;
}

/**
 * `unreachable` is deliberately distinct from `denied`.
 *
 * Both refuse the payment, but only one is true. Reporting a failed send as "the owner denied
 * this payment" sends the operator looking for a person who never received anything, and hides a
 * broken integration behind a plausible policy outcome — which is exactly what happened on the
 * first live dry run.
 */
export type ApprovalVerdict = "approved" | "denied" | "timeout" | "unreachable";

export interface ApprovalChannel {
  request(ticket: ApprovalTicket): Promise<ApprovalVerdict>;
}
