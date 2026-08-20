/**
 * MCP tool schemas. Rules: every money tool REQUIRES idempotency_key; outputs never contain
 * keys/secrets; claim-link secret is returned ONCE inside a claim URL and never logged.
 * TODO(claude-code): implement server with @modelcontextprotocol/sdk (stdio), wire to policy+core+approvals.
 */
export const TOOLS = [
  { name: "get_balance",      desc: "Shielded balances per token" },
  { name: "pay_private",      desc: "Private in-pool payment. Params: token, amount, recipient, memo?, idempotency_key. May return needs_approval." },
  { name: "create_claim_link",desc: "Pay an unregistered recipient via escrow claim link. Params: token, amount, expiry_blocks?, memo?, idempotency_key" },
  { name: "withdraw",         desc: "Unshield to a public address (PUBLIC edge). Params: token, amount, to, idempotency_key" },
  { name: "list_activity",    desc: "Recent decisions + receipts (audit view)" },
  { name: "get_policy",       desc: "Current caps/allowlist/thresholds (read-only)" },
] as const;
