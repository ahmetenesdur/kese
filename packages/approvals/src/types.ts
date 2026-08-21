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

export type ApprovalVerdict = "approved" | "denied" | "timeout";

export interface ApprovalChannel {
  request(ticket: ApprovalTicket): Promise<ApprovalVerdict>;
}
