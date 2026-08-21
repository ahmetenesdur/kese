# PLAN.md — 10 days to submission (Aug 21 → Aug 31, 2026)

Deadline: **Aug 31, 23:59 UTC**. Judging: 30% STRK20 depth · 30% mainnet product · 25% innovation · 15% docs.
Rule of thumb: cut features, never cut the demo/video/docs days.

## Phase S — Spike & unblock (Day 1, Aug 21)
- [x] Owner: registry PR submitted → applied to main by automation (PR #146, commit 826bf64) — **registered**
- [x] Owner: proving-access issue opened → starkience/strk20-hackathon#147 (awaiting reply; watch notifications)
- [x] SDK install — GitHub Packages **403: `gh` token lacks `read:packages`**. Unblocked by building the public monorepo (`36eac4e`, v0.14.3-rc.5) and installing the packed tarball from gitignored `vendor/` (decisions D-005). **Owner: run `gh auth refresh -h github.com -s read:packages` to restore the canonical install.**
- [x] `scripts/day1-sepolia-smoke.ts` implemented — 3 modes (`mock` / `simulate` / `service`), full preflight, blocker attribution, JSON report
- [x] `--mode=mock`: **7/7 steps pass** — register (both parties) → shield → discoverNotes → private transfer → recipient-side verification → withdraw
- [x] `--mode=simulate` preflight green against live Sepolia: RPC (spec 0.10.3-rc.0), pool `0x0254a6…0d91`, STRK token, `provingBlockId = head − 10`
- [x] `scripts/gen-smoke-keys.ts` (`pnpm keys:gen`) — CSPRNG signer + viewing key written straight into `.env`, never printed; counterfactual address printed for funding; `--deploy` deploys it. Sepolia-only by construction
- [x] Owner: signer generated + funded + deployed — account `0x76bdc7…4062`, deploy tx `0x300f9d…4ba1`, 2999.94 STRK
- [x] `--mode=simulate` **against the live Sepolia pool**: `discoverRequirement` → `Register`, `discoverNotes` → 0, **shield simulated: 56 felts of `apply_actions`, node-executed, ~670 ms**. Transfer/withdraw are n/a until a real deposit lands (simulate doesn't mutate state)
- [ ] `--mode=service` full run — blocked **only** on **proving URL** (#147, upstream). Everything else is wired and green
- [x] Measure: proof-time instrumentation in place (`TimedProofProvider` isolates prove() from submission); real numbers await the proving URL. Failure modes recorded in docs/decisions.md D-005..D-009
- **GATE G1:** Did the smoke test pass? If not → 1 day of debugging; if still red by end of Day 3 → switch to the Wallet-API-route fallback design (below) or withdraw. Apply without sentiment.
  - **Day-1 verdict: PARTIAL / open — do not pivot.** Nothing failed for a reason inside our control; the only blockers are externally owned. "Red" means *our* code fails, not that a third party hasn't replied. Full evidence: docs/decisions.md D-009.

## Phase A — Policy core (Days 2-3)
- [x] `packages/policy`: per-tx + rolling-24h caps, allowlist, SQLite persistence (`node:sqlite`, no native dep — D-012), reservation lock, idempotency store, decision log
- [x] Vitest: **44 tests** — race conditions (10 parallel payments against a 2-payment cap), window boundaries (23h counts / 24h+1 drops), idempotent replay (incl. same-key-different-request → deny), fail-closed (storage down, malformed addresses)
- [x] Acceptance met: `decide(request)` → `allow | deny(code, reason) | needs_approval(ticket)`, deterministic and under test
- [x] Cap semantics decided by owner: **caps are absolute, never approvable past** (D-011)
- [ ] Config loading (`PolicyConfig` from env/file) — deferred to Phase B, where the MCP server needs it

## Phase B — Core wallet + MCP (Days 3-5)
- [x] Invoked the `strk20-privacy-integration` skill → `STRK20_INTEGRATION_PLAN.md` (route confirmed: SDK direct)
- [x] `packages/core`: SDK wrapper — `KeseWallet` (register/shield/payPrivate/withdraw/balances), chain submitter with 10-block sequencing, live wiring, proof timing. Smoke script now drives the library; verified on live Sepolia
- [ ] **note denomination ladder** (notes.ts) — Phase B2, next
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
