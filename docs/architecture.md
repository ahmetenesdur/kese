# Architecture

```
LLM agent ──stdio──► packages/mcp ──► packages/policy  (ALWAYS between a tool and money)
                          │                 │ allow · deny(code) · needs_approval
                          │                 ▼
                          │          packages/approvals ──► Telegram
                          ▼
                     packages/core ──► STRK20 pool ──privacy_invoke──► contracts/escrow-claim
                                                                              ▲
                                              apps/claim (public, static) ────┘
   apps/dashboard (loopback only) ──► packages/policy + packages/core
```

## Components

- **packages/mcp** — the MCP server. `src/server.ts` builds the six tools from injected
  dependencies; `src/main.ts` is the runnable program that constructs them, and is the only file
  that touches the outside world. Tools: `kese_get_balance`, `kese_get_policy`,
  `kese_list_activity`, `kese_pay_private`, `kese_withdraw`, `kese_create_claim_link`. Every money
  tool requires an `idempotency_key`, takes whole tokens (`"1.5"`) rather than base units, and
  returns receipts, never secrets. `spend.ts` is the single guarded pipeline; the tools are thin
  wrappers over it.
- **packages/policy** — deterministic decision core over SQLite (`node:sqlite`).
  `decide(req) → allow | deny(code) | needs_approval`, evaluated in a fixed order: validate,
  allowlist, token configured, per-tx cap, approval threshold, daily cap. Reservations are taken
  inside `BEGIN IMMEDIATE` before execution and released on failure, so concurrent payments cannot
  both fit a cap only one of them fits. The decision log is the audit trail, and records refusals —
  which never reach the chain and are exactly what an audit view is for.
- **packages/approvals** — Telegram. Ticket → message stating amount, recipient, which rule fired
  and the effect on the daily budget → inline approve/deny → the payment resumes or is refused.
  Four verdicts, not two: `approved`, `denied`, `timeout`, `unreachable` — a failure to *send* must
  never be reported as the owner saying no.
- **packages/core** — the STRK20 wrapper. Wallet (register / shield / transfer / withdraw /
  discovery), `notes.ts` denomination ladder (round denominations so a burst of payments draws on
  distinct mature notes instead of queueing behind the 10-block wait), `chain.ts` submitter (the
  10-block rule, `tip: 0n`, mainnet arming), claim-link secrets, escrow calldata, and env/state-path
  resolution.
- **contracts/escrow-claim** — Cairo `privacy_invoke` helper. Deposit(commitment) / Claim(secret) /
  **Refund after expiry** — the refund path is our extension over the reference escrow, because an
  agent that pays a wrong address should not simply lose the money. Claim and refund hash under
  separate domain tags so a link cannot be replayed down the other path.
- **apps/claim** — the recipient's page and the project's public demo. Static: it reads the escrow
  over RPC and has no server, because the claim secret rides in the URL *fragment* and a server is
  a place that could log it. Claiming runs in the visitor's own wallet, which does its own proving.
- **apps/dashboard** — the owner's view. A small `node:http` server, not a framework: reading
  shielded balances needs the viewing key, and the viewing key never leaves the server. Binds to
  `127.0.0.1` and has no authentication *because* it has no network path; it must never be
  deployed publicly. Shows balances, limits, merged activity, and exports a spend report as CSV.

## Payment flow (happy path)

1. Agent calls `kese_pay_private{recipient, token, amount, memo, idempotency_key}`.
2. Idempotency check. A known key returns the original receipt and executes nothing.
3. `policy.decide` → a reservation is held from this point on.
4. If `needs_approval`: a Telegram ticket. Approve continues; deny, timeout or an unreachable
   channel all release the reservation and refuse.
5. `core` selects mature notes via the ladder, builds the transfer, proves against
   `head − 10`, submits with `tip: 0n`, waits for the receipt.
6. Commit the reservation with the receipt, log the decision, return `{status, txHash?}`.

Anything that fails after step 3 releases the reservation. Nothing is reported as `paid` unless it
settled: a compile-and-check run in simulate mode returns its own `simulated` status.

## Rules that live in exactly one place

Each of these had, or nearly had, a second copy — and each one's failure mode is silent.

| Rule | Where | If it were duplicated |
|---|---|---|
| Every money path goes through policy | `mcp/src/spend.ts` | A tool could spend outside the caps |
| Where the idempotency database lives | `core/src/statepath.ts` | Two databases ⇒ a retry pays twice |
| Mainnet submissions must be armed today | `core/src/chain.ts` | A stale flag arms every future run |
| Secrets scrubbed before anything is logged | `core/src/config.ts` | A key reaches a log or a tool result |

## Security model

The LLM never sees the private key, the viewing key, or a claim secret. Every error crosses the
redactor before it can become a log line, a tool result or a screenshot. Claim-link secrets are
CSPRNG-generated server-side, shown once, and only their hash is stored. The MCP server speaks
stdio, deliberately: it holds the signing key and should not be reachable over a network. It
refuses to start without a spending policy, because a wallet server that came up with no limits
would be worse than one that failed — the agent would find it working.

Policy state is the source of truth. MCP input is untrusted, and so is the memo an LLM writes: the
CSV export neutralises leading `=`, `+`, `-` and `@`, since a refused payment is enough to carry a
formula into the owner's spreadsheet.

## Failure modes

| What fails | What happens |
|---|---|
| No proving service | Payments compile and check against live pool state, then return `simulated` — never `paid`. The reservation is released. |
| Approvals unreachable | `unreachable`, distinct from the owner denying. Fail closed. |
| Policy database unavailable | Deny. Never guess. |
| RPC flaky | Retry; idempotency prevents a double-send. |
| Note not yet mature | The submitter waits for depth rather than proving against state that is too new, so a caller cannot forget the rule. |
| Wrong network armed | A mainnet submission without today's arming date is refused at the submitter, before the fee estimate and before anything is signed. |
