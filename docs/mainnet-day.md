# Mainnet day — the runbook

The three eligible transactions are the one requirement with no second chance: miss them and the
submission is not judged at all. This file exists so that day is a sequence to follow rather than a
sequence to work out.

**Prerequisite, and the only one:** a working proving service. Everything below is already proved
against the live mainnet pool in simulate mode; nothing here is a first attempt except the
submission itself.

---

## Before you start

| | Check | How |
|---|---|---|
| 1 | Proving service answers | `curl -s -X POST "$PROVING_SERVICE_URL_MAINNET" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}'` → expect `0.10.0` |
| 2 | Preflight is green | `KESE_NETWORK=mainnet pnpm smoke -- --mode=simulate` — every line ✅, no `[enes]` blockers |
| 3 | Balance covers it | **24 STRK in pool fees** + the shielded amount + gas; keep the unverified 24 STRK proving reserve on top until it is measured |
| 4 | Nothing uncommitted | `git status --short` clean, so the run is reproducible from a known commit |

If you are running your own prover, `./scripts/prover-up.sh --network mainnet --rpc-url "$RPC_URL_MAINNET"`
prints the exact line to paste into `.env`. Time one proof before starting: the machine size is
unverified, and finding out mid-sequence is the bad way to learn it.

## The sequence

Arming expires daily, so it is set once, today:

```bash
export KESE_NETWORK=mainnet
export KESE_MAINNET_ARMED=$(date -u +%Y-%m-%d)
```

Then:

```bash
pnpm smoke -- --mode=service
```

That is the whole run. What it does, in order:

| # | Step | Pool fee | Eligible? |
|---|---|---|---|
| 1 | **register** — publish the viewing key | 6 STRK | ✅ pool event |
| 2 | **approve** — let the pool pull the deposit | — gas only | ❌ plain ERC-20, no pool event |
| 3 | **shield** — deposit into the pool | 6 STRK | ✅ |
| 4 | **private transfer** — half the shielded amount | 6 STRK | ✅ |
| 5 | **withdraw** — a quarter, back out | 6 STRK | ✅ |

**Four pool operations at 6 STRK each is 24 STRK in fees**, not 18 — the run does a transfer *and*
a withdraw. Plus the shielded amount and gas. It produces four eligible hashes where three are
required, which is the right amount of slack: if one reverts, the submission is still complete.

Step 2 is a transparent transaction, and the 10-block rule applies to it too — the deposit proof
reads the allowance, so it must have settled. Every wait is enforced by the submitter itself
(`chain.ts`, `blocksUntilProvable`); there is nothing to remember.

**How long.** Mainnet blocks run about **1.7 seconds** (measured over 200 blocks), so each
ten-block wait is roughly 17 seconds and all four together are about a minute. The waits are not
what makes this slow — **proving time is**, and it is unverified. If you are self-hosting, time a
single proof before starting rather than discovering the number mid-sequence.

## When it finishes

`smoke-report.json` holds the transaction hashes. For each one:

```bash
# must be SUCCEEDED, and must carry at least one event from the pool
starkli receipt <hash>   # or read it over RPC
```

Eligibility needs each hash to **exist, have succeeded, and carry a STRK20 pool event** — *any*
pool event, not specifically a `Deposit` (D-040). The account-deploy transaction does **not**
qualify: it carries none.

Then put them in `strk20.json`:

```json
"transactions": ["0x…", "0x…", "0x…"]
```

and push. Nothing goes in that file until it is real.

## If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| `refusing to submit a mainnet transaction` | `KESE_MAINNET_ARMED` is unset or stale | Re-export it with today's UTC date |
| Proof rejected, base block too new | A wait was skipped | Should be impossible — the submitter sequences it. Report it. |
| `-32005` from the prover | At concurrent capacity | Retry; raise `MAX_CONCURRENT_REQUESTS` if self-hosted |
| Transaction reverted | Read `revert_reason` in the receipt | Do **not** retry blindly — a retry with the same idempotency key returns the original result, which is correct, but a *new* key spends again |
| Ran out of STRK mid-sequence | Fees are 6 per operation, not per run | Fund and re-run; completed steps are idempotent by key |

**The one thing not to do:** invent a transaction hash, or list one that did not touch the pool.
The check is automated and a wrong hash is worse than a missing one.

## What is already done, and needs no repeating

- Mainnet account deployed — `0x76bdc7a5…14062`, block 13639611.
- Escrow deployed and verified — `0x4b41a564…4999f3`, block 13640339, `pool()` returns the mainnet
  pool. Already in `strk20.json`.
- Demo live and git-linked.
- The whole flow rehearsed against the live pool in simulate mode: pool reachable,
  `discoverRequirement` → Register, shield compiles and is executed by the node.
