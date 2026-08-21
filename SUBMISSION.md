# SUBMISSION.md — where the hackathon submission stands

Deadline **31 August 2026, 23:59 UTC**. Finish hours early, not minutes.

## The manifest

`strk20.json` at the repo root is what gets judged. Current state:

| Field | State |
|---|---|
| `demo_url` | ✅ `https://kese-claim.vercel.app` — live, rebuilds from `main` on every push |
| `contracts[]` | ⬜ escrow deployed on **Sepolia** (`0x1ff4c7f2…3108`); mainnet deploy needs no proof and can happen any time |
| `transactions[]` | ⬜ three mainnet transactions carrying a STRK20 pool event — **blocked on proving** |
| `demo_video` | ⬜ owner records; three minutes |

Two of these are still placeholders and will stay placeholders until they are real. A manifest
with an aspirational hash in it is worse than one with an obvious `TODO`.

**What counts as an eligible transaction.** Each hash must exist, have succeeded, and carry a
STRK20 pool event — *any* pool event, not specifically a `Deposit` (D-040). Note that the mainnet
account deployment does **not** qualify: it carries zero pool events.

**Why they are blocked.** The pool's only user-facing entrypoint is `apply_actions`, which consumes
the output of a proof. There is no `deposit` or `register` entrypoint, and a STARK proof cannot be
produced on-chain — so nothing reaches the pool without a proving service (D-044).

## Done

- **Registered.** `ahmetenesdur/kese` is in the upstream `registry.json`, among 110 projects.
- **Proving access requested.** Issues #147 (ours) and #124, plus #121 and #135 from other teams.
  No maintainer reply as of 21 August; upstream commit `52e7b63` acknowledges six blocked teams.
- **Mainnet account live and funded.** `0x76bdc7a5…14062`, deployed in block 13639611, holding
  ~115 STRK. Every mainnet preflight check passes.
- **Public demo.** Built from this repository, no credential stored on Vercel.
- **Repo public, MIT.**

## Remaining, in the order they can happen

1. **Mainnet escrow deploy** — needs no proof, so it can be done today. Fills `contracts[]`.
   `KESE_NETWORK=mainnet pnpm escrow:deploy -- --i-mean-mainnet` (dry-run first, it is free).
2. **Proving service** — either the hosted URL arrives, or `./scripts/prover-up.sh` on a rented
   amd64 Linux box (Gate G1 decision, 23 August).
3. **Three mainnet transactions**, immediately after 2. The dry run has already proved the wiring,
   so this is a submission rather than a debugging session.
4. **Video** — four beats: a private payment, a Telegram approval on a limit breach, a claim link,
   the audit view.

## Judging weights, and where they are earned

| Criterion | Weight | Where |
|---|---|---|
| STRK20 integration depth | 30% | register / shield / transfer / withdraw / discovery / note ladder / `privacy_invoke` escrow / viewing-key reporting |
| Working mainnet product | 30% | live pool integration, public demo; the three transactions are the gap |
| Innovation | 25% | policy-guarded agent spending, LLM-safe tool design, claim links with refund |
| Documentation & open source | 15% | `README.md`, `docs/`, `llms.txt`, the decision log, MIT |

## Afterwards (Sep 4+)

- [strk20.starknet.io/rfp](https://strk20.starknet.io/rfp) → **Book a call** (cal.com/adithyadinesh),
  with the Kese demo.
- PROOF accelerator (proof.starknet.io) — they want "prototype/MVP + users"; Kese fits.
