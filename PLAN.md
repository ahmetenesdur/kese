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
- [x] **note denomination ladder** (notes.ts) — `planLadder`/`selectNotes`/`ladderGaps`, 19 tests. Ladder + single reserve note (a full split shredded a large balance into 10k notes); exact-change preferred so a payment creates no new note to mature
- [x] `packages/mcp`: 6 tools (prefixed `kese_*` — D-018), `idempotency_key` required by schema on every money tool, single guarded `spend()` pipeline so no path bypasses policy. Server refuses to start without a policy config. 46 tests incl. a real MCP client over in-memory transport
- [x] `packages/approvals`: Telegram — ticket → message (amount, recipient, which rule fired, budget left) → inline Approve/Deny → resume. Owner-chat check on every update; timeout/unknown/duplicate/transport-error all deny; tickets persisted so a restart releases stranded reservations. No client-library dependency (raw fetch). 23 tests
- Acceptance: end-to-end private payment on Sepolia from Claude Desktop via MCP + Telegram approval on limit breach
  - [x] MCP + policy + approval chain fully wired and testable today (`PROVING_MODE` simulate/mock)
  - [ ] The on-chain half is gated on the proving URL (#147) — everything else is ready

## Phase C — Cairo: escrow claim-link (Days 5-7, can run parallel to B)
- [x] Escrow written with the **expiry & refund** extension — the payer holds a refund secret, because the escrow cannot see who is asking (D-030). Also enforces that a deposit is backed by funds not already promised
- [x] **19 snforge tests**, security guarantees **mutation-verified** — which caught a test that passed for the wrong reason (D-028)
- [x] Sepolia deploy: `0x1ff4c7f2…3108`, `pool()` verified on-chain (D-032)
- [x] Claim-link secrets: two independent CSPRNG felts, commitment pinned against Cairo from both sides (D-031); escrow calldata builders tested for positional order
- [x] Wire `create_claim_link` through the pool invoke: withdraw-to-escrow + invoke in ONE transaction; two CSPRNG secrets; the refund secret persisted server-side, the claim URL returned **once** and stored nowhere. Not executable until #147, but fully wired and tested
- [ ] Claim page (apps/dashboard) — with the honest "the amount is public" notice
- **Watch (D-033):** claim/refund each credit an open note, which makes the ESCROW the pool's screening subject. In the SDK's unreleased version an unlisted depositor defaults to `Required` and only the pool governor can list one. Verified on-chain: both pools are still `v2.0` with the older allow-by-default block list and our escrow is not blocked — **viable today**, at risk if the pool upgrades mid-sprint. Ask on #147.
- Fallback: if Cairo stalls → cut claim links, ship "registered-only payments" (contracts field stays empty; acceptable loss). Softer fallback first: escrow pays the claimer by plain ERC-20 transfer instead of an open note — claimer loses privacy, funds stay recoverable.

## Phase M — Mainnet (Day 8, Aug 28)
- [x] Escrow deployed to **mainnet** — `0x4b41a564…4999f3`, block 13640339, declare+deploy cost
      8.73 STRK. `pool()` verified against the mainnet pool. Needs no proof; recorded in `strk20.json`.
      Runbook for the remaining three transactions: `docs/mainnet-day.md`.
- [x] Mainnet account funded — 115 STRK. Every mainnet preflight check now passes, including the
      unverified 24 STRK proving reserve. Nothing on the owner's side is outstanding for Phase M;
      the three transactions are held solely by the missing proving service.
- [x] Mainnet account deployed — `0x76bdc7a5…14062`, tx `0xe805d13b…171612`, block 13639611,
      gas 0.054 STRK. Armed with `KESE_MAINNET_ARMED`. NOT an eligible transaction: it carries
      zero pool events. Preflight now passes everything except the unverified 24 STRK reserve.
- [x] Mainnet dry run (simulate): pool reachable, `discoverRequirement` → Register, shield compiles and is node-executed — with no deployed account. Day 8 is funding + submitting, not debugging (D-040)
- [x] Costs read from the chain: pool fee **6 STRK per operation** on mainnet (2 on Sepolia), proof validity 450 blocks. **Owner: budget ~45–50 STRK** — 3 ops ≈ 18 in fees, plus the shielded amounts, gas, account deploy, and the unverified ~24 reserve
- [x] Eligibility clarified: three hashes each carrying **any** STRK20 pool event — not necessarily deposits (D-040)
- [ ] Small amounts on mainnet: register + shield + ≥3 pool transactions (hashes into `strk20.json`)
- [ ] Deploy escrow to mainnet (if ready) → fill `contracts[]`
- [x] Dashboard (apps/dashboard): balances, limits with a used-budget meter, merged activity (policy attempts + on-chain shields). Loopback-only server so the viewing key stays server-side. On-chain reads use the `Deposit` event's first indexed key — verified against mainnet: 16 deposits, **10 distinct depositors** (filtering by sender would have shown 1)
- [x] Spend report export (CSV) — includes refusals, and neutralises spreadsheet formula injection in the LLM-written memo field (D-039)

## Phase D — Demo & docs (Days 9-10, Aug 29-30)
- [x] Public demo deploy (Vercel) → `demo_url` = https://kese-claim.vercel.app (production, live,
      no credential stored on Vercel). Reproducible via `node scripts/build-vercel-tree.mjs` — verified
      to rebuild the deployed artifact byte-for-byte (same content hash). See D-042.
- [ ] 3-minute video: (1) tell Claude "pay $5" → goes through privately; (2) "send $300" → Telegram approval; (3) claim-link payment to an unregistered recipient; (4) report screen
- [x] README polish: architecture diagram, STRK20-depth table, honest "privacy limitations" and
      "status" sections, setup guide that works from a clean clone (repo `.npmrc` + vendor fallback).
      Writing it broke three things that had never been run: `escrow:*` on any PATH with a space,
      the MCP server (no entrypoint existed — `packages/mcp/src/main.ts` is new), and cwd-relative
      `.env`/`POLICY_DB_PATH` lookup (the latter could re-execute a retried payment). See D-041.
- [ ] Final `strk20.json` + last push

## Day 11 (Aug 31) — Buffer only
- [ ] Final checks; be done hours before 23:59 UTC

## Decision gates summary
- **G1 (Days 1-3):** SDK+proving not working → **first** try a self-hosted prover. `./scripts/prover-up.sh`
  now does it in one command on a rented amd64 box, with the RPC v0.10 check up front (D-043). (D-037: the image is public, needs only a v0.10 RPC, but wants a real Linux box — arm64 build SIGILLs on Apple Silicon). Only if that fails → Wallet-API fallback (the owner's Ready wallet produces proofs; agent "proposes", wallet "approves" — less autonomous but shippable) or withdraw. Ordering matters: self-hosting keeps the agent autonomous, which is the whole premise; the Wallet-API route gives it up.
- **G2 (Day 7):** Cairo delayed → cut claim links.
- **G3 (Day 8):** unexpected mainnet blocker → Sepolia demo + a minimal 3-tx mainnet flow (guarantee eligibility).
