/**
 * Tool inventory, kept as data for docs and tests.
 * The authoritative definitions (schemas, annotations, handlers) live in server.ts.
 */
export const TOOLS = [
  { name: "kese_get_balance", money: false, desc: "Shielded balances per token" },
  { name: "kese_get_policy", money: false, desc: "Caps, allowlist and approval threshold (read-only)" },
  { name: "kese_list_activity", money: false, desc: "Kese's decision log — the audit trail" },
  { name: "kese_pay_private", money: true, desc: "Private in-pool payment" },
  { name: "kese_withdraw", money: true, desc: "Unshield to a public address (PUBLIC edge)" },
  { name: "kese_create_claim_link", money: true, desc: "Pay an unregistered recipient via escrow" },
] as const;
