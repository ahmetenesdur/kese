# PLAN.md — 10 days to submission (Aug 21 → Aug 31, 2026)

Deadline: **Aug 31, 23:59 UTC**. Judging: 30% STRK20 depth · 30% mainnet product · 25% innovation · 15% docs.
Rule of thumb: cut features, never cut the demo/video/docs days.

## Phase S — Spike & unblock (Day 1, Aug 21)
- [ ] Owner: fork + registry.json PR (entry template in SUBMISSION.md) — register immediately, don't wait
- [ ] Owner: open GitHub issue requesting the mainnet **proving service URL** (the Day-0 guide says to ask via issue); ask for the Sepolia URL too
- [ ] SDK install (GitHub Packages auth! notes §1) + `scripts/day1-sepolia-smoke.ts`: register → shield → private transfer → withdraw on **Sepolia**
- [ ] Measure: proof time, failure modes. Record in docs/decisions.md
- **GATE G1:** Did the smoke test pass? If not → 1 day of debugging; if still red by end of Day 3 → switch to the Wallet-API-route fallback design (below) or withdraw. Apply without sentiment.

## Phase A — Policy core (Days 2-3)
- [ ] `packages/policy`: limits (per-tx / rolling daily), allowlist, SQLite persistence, **reservation lock** (concurrent spend), **idempotency store**, decision log
- [ ] Vitest: race conditions, window boundaries, idempotent replay, fail-closed
- Acceptance: `decide(request)` → `allow | deny(reason) | needs_approval(ticket)` deterministic and under test

## Phase B — Core wallet + MCP (Days 3-5)
- [ ] Invoke the `strk20-privacy-integration` skill at phase start (see CLAUDE.md "Skills")
- [ ] `packages/core`: SDK wrapper (init, register, shield, transfer, withdraw, discoverNotes) + **note denomination ladder** (notes.ts)
- [ ] `packages/mcp`: tools — `get_balance`, `pay_private`, `create_claim_link`, `withdraw`, `list_activity`, `get_policy`; `idempotency_key` required on all; NO path bypasses policy
- [ ] `packages/approvals`: Telegram bot — needs_approval ticket → message (who/how much/balance impact) → approve/deny → resume
- Acceptance: end-to-end private payment on Sepolia from Claude Desktop via MCP + Telegram approval on limit breach

## Phase C — Cairo: escrow claim-link (Days 5-7, can run parallel to B)
- [ ] Adapt the reference escrow + add the **expiry & refund** extension (our contribution) — spec: contracts/escrow-claim/README.md
- [ ] snforge tests (deposit/claim/double-claim/refund-before-and-after-expiry)
- [ ] Sepolia deploy → wire into MCP `create_claim_link` (CSPRNG secret, shown once, claim page)
- Fallback: if Cairo stalls → cut claim links, ship "registered-only payments" (contracts field stays empty; acceptable loss)

## Phase M — Mainnet (Day 8, Aug 28)
- [ ] Small amounts on mainnet: register + shield + ≥3 pool transactions (hashes into `strk20.json`)
- [ ] Deploy escrow to mainnet (if ready) → fill `contracts[]`
- [ ] Dashboard (apps/dashboard): balances, activity list, viewing-key spend report (simple but polished — brand kit: strk20.starknet.io/brand)

## Phase D — Demo & docs (Days 9-10, Aug 29-30)
- [ ] Public demo deploy (Vercel) → `demo_url`
- [ ] 3-minute video: (1) tell Claude "pay $5" → goes through privately; (2) "send $300" → Telegram approval; (3) claim-link payment to an unregistered recipient; (4) report screen
- [ ] README polish: architecture diagram, judging-criteria map, honest "privacy limitations" section, setup guide
- [ ] Final `strk20.json` + last push

## Day 11 (Aug 31) — Buffer only
- [ ] Final checks; be done hours before 23:59 UTC

## Decision gates summary
- **G1 (Days 1-3):** SDK+proving not working → Wallet-API fallback (the owner's Ready wallet produces proofs; agent "proposes", wallet "approves" — less autonomous but shippable) or withdraw.
- **G2 (Day 7):** Cairo delayed → cut claim links.
- **G3 (Day 8):** unexpected mainnet blocker → Sepolia demo + a minimal 3-tx mainnet flow (guarantee eligibility).
