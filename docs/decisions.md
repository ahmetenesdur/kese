# Decisions log (ADR-lite)

- D-001 (revised, see D-007): Discovery via ContractDiscoveryProvider (no indexer dependency). Revisit if too slow.
- D-002 (planned): SDK route for agent spending; Wallet API (Ready) only for owner onboarding. Gate G1 fallback: wallet-cosigned mode.
- D-003 (revised, see D-012): SQLite for policy state — single-node, transactional, zero-ops.
- D-004 (open): mainnet proving URL — requested via starkience/strk20-hackathon#147 (Aug 21); awaiting reply. Registration applied upstream as 826bf64 (PR #146).

---

## Day 1 (Aug 21, 2026) — Phase S spike

Source of truth for everything below: the SDK monorepo at `starkware-libs/starknet-privacy`
commit `36eac4ea88cd8c59dde1493176e16501c6e90328`, package version **0.14.3-rc.5**.
Where the SDK's own types contradict `docs/strk20-notes.md` or the SDK README, the **types win**
— both prose sources carry stale examples (details in D-008).

### D-005 — SDK obtained by building the public monorepo, not from GitHub Packages

**Blocked:** `pnpm add @starkware-libs/starknet-privacy-sdk` fails with

```
npm error 403 Forbidden - GET https://npm.pkg.github.com/@starkware-libs%2fstarknet-privacy-sdk
npm error Permission permission_denied: The token provided does not match expected scopes.
```

The local `gh` token has scopes `gist, read:org, repo, workflow` — **`read:packages` is missing**.
`docs/strk20-notes.md` §1 names the fix (`gh auth refresh -h github.com -s read:packages`) but that
is an interactive device-flow, so it is an **owner action**.

**Decision:** unblock locally without weakening the install. The SDK monorepo is public (Apache 2.0),
so we cloned it, ran `npm ci && npm run build` in `sdk/`, `npm pack`ed the result, and installed the
tarball from a **gitignored** `vendor/` directory. No `--force`, no skipped integrity checks — the
artefact is the SDK's own build output.

**Reproducibility:** `./scripts/vendor-sdk.sh` rebuilds the identical tarball from the pinned
commit, so `pnpm install` works on a fresh clone without the scope. The lockfile references
`vendor/…tgz`, which is gitignored — run that script first on a clean checkout.

**Revert condition:** as soon as the `read:packages` scope exists, swap the `file:` specifier in
`package.json` and `packages/core/package.json` back to a registry version and delete `vendor/`.
The vendored tarball is deliberately **not committed** so the repo never ships a pre-release build.

### D-006 — Three proving modes, so the flow stays testable while proving is blocked

`PROVING_SERVICE_URL` is unknown (D-004), and a private transfer cannot land on-chain without a real
STARK proof. Rather than fake a proof, the smoke test uses the two mock paths the SDK **already
supports**, and keeps them as first-class modes:

| `--mode` | Chain | Proofs | Submits | Answers |
|---|---|---|---|---|
| `mock` | none (in-memory `Mocknet`) | `MockProofProvider` | applies to mock pool | Is our *flow choreography* right? |
| `simulate` | live Sepolia | SDK's internal mock prover via `.simulate({ node })` | no | Is our *wiring against the live pool* right? |
| `service` | live Sepolia | real proving service | yes | Gate G1 proper |

This is not a workaround we invented: `simulate()` is the SDK's documented fee-estimation path and
runs the full compile pipeline (discovery → note selection → calldata) against real pool state.

### D-007 — `ContractDiscoveryProvider` ships from the `/testing` subpath (revises D-001)

D-001 chose `ContractDiscoveryProvider` as our default to avoid an indexer dependency. The SDK
exports it from **`@starkware-libs/starknet-privacy-sdk/testing`**, not the package entry point, and
its README calls it "best for development and testing"; `IndexerDiscoveryProvider` is the documented
production choice. It also takes a **pool contract object**, not an address.

**Decision:** keep it for Phase S (no external dependency beats production-shaped for a spike), but
D-001 is no longer safe to carry into production unexamined. `packages/core` already prefers
`IndexerDiscoveryProvider` whenever `INDEXER_URL` is set. **Re-decide before Phase M** — shipping a
mainnet product on a provider the vendor labels "for testing" is a judging risk as well as a
technical one.

### D-008 — Corrections to docs/strk20-notes.md, verified against SDK types

Logged per CLAUDE.md ("where its plan conflicts with the notes, log the conflict"). Here the
conflict is with the notes themselves; `docs/strk20-notes.md` has been amended.

1. **`ContractDiscoveryProvider` import path and argument** — see D-007. Notes §2 implied the package
   entry point and an address.
2. **The 10-block rule also covers transparent transactions.** Notes §4 framed it as note maturity
   only. Per the SDK README, any on-chain state the proof reads must be ≥10 blocks old — including
   an account's `deploy` before `register()`, and an ERC-20 top-up before `deposit()`. This is a
   real sequencing hazard for the agent: a burst payer that shields and immediately spends will fail.
   (Reinforces why `packages/core/src/notes.ts` matters.)
3. **Submission shape.** `execute()` returns `{ callAndProof, registry, warnings }`; the caller
   submits with `account.execute(callAndProof.call, { tip: 0n, proofFacts: …proof.proofFacts,
   proof: …proof.data })`. `tip: 0n` confirmed mandatory.
4. **Stale README examples (not the notes' fault, but worth pinning).** The SDK README shows
   `simulate({ provider })` — the type is `{ node }`; and a JSDoc example shows `deposit(100n)` —
   the type is `deposit({ amount })`. Trust `dist/interfaces.d.ts`.
5. **`ContractDiscoveryProvider` needs a *typed* pool contract.** It calls the pool's view methods
   by name (`get_public_key`, `get_note`, `channel_exists`, …), so it wants
   `new Contract({ abi: PrivacyPoolABI, address, providerOrAccount }).typedv2(PrivacyPoolABI)` —
   the ABI is exported from the `/abi` subpath. A generic `{ call() }` shim typechecks through a
   cast and then dies at runtime on the first view call; that is exactly what happened on the first
   live run.
6. **`simulate()` still needs a proving provider.** It builds its own `CallMockProofProvider`
   internally and never calls `prove()` on the configured one — but `createProofInvocation()` asks
   the configured provider for `getDefaultDetails()` (pool nonce, chainId) while compiling. Pass
   `new CallMockProofProvider(node, chainId)` in simulate mode; a stub that throws on every method
   will fail at compile time, not proving time.
7. **Not a correction:** notes §2's `provingProvider: { url, chainId }` is valid. The factory accepts
   `ProofProviderInterface | ProofProviderConfig` and builds the production provider from a config.

### D-009 — Gate G1 status at end of Day 1: **PARTIAL / open — do not pivot**

Evidence (`smoke-report*.json`; reproduce with `pnpm smoke:mock` / `pnpm smoke:simulate`).

**`--mode=mock`: 7/7 steps pass.** register (both parties) → shield → discoverNotes → private
transfer → *recipient-side note verification* → withdraw. Builder chains, channel setup and note
handling are correct.

**`--mode=simulate`: runs against the live Sepolia pool with the real signer.** Preflight fully
green — RPC (spec `0.10.3-rc.0`), pool `0x0254a6…0d91`, STRK token, account
`0x76bdc7…4062` deployed and funded (2999.94 STRK), `provingBlockId = head − 10`. Then:

| Step | Result |
|---|---|
| `discoverRequirement` | `Register (0)` — the live pool correctly reports our fresh account as unregistered |
| `discoverNotes` | 0 notes — correct, nothing shielded yet |
| `shield (simulated)` | **56 felts of `apply_actions` calldata, node-simulated, ~670 ms** |
| `private transfer`, `withdraw` | *not applicable* — see below |

The shield simulation is the strongest signal available today: `CallMockProofProvider` runs the
invocation through the node's transaction simulation and captures what the pool would have emitted.
The pool contract really executed our calldata.

The two spending steps are **not applicable, not broken**. `simulate()` does not mutate state, so
the shield above created nothing on-chain, and there are no notes to spend. Landing a real deposit
needs a real STARK proof — every pool transaction goes through `apply_actions` with `proof` +
`proofFacts`, and a mock proof will not verify on-chain. So this is precisely the ceiling of what is
reachable without the proving service; the script reports it as a skip with a reason rather than a
red failure.

**Blocked, precisely:**

| What | Owner | Status |
|---|---|---|
| Sepolia signer | Enes | ✅ **cleared** — generated by `pnpm keys:gen`, deployed in `0x300f9d…4ba1` |
| `PROVING_SERVICE_URL_SEPOLIA` | upstream | ⛔ open — strk20-hackathon#147 |
| `read:packages` scope (D-005) | Enes | ⛔ open — `gh auth refresh -h github.com -s read:packages` |

**Nothing failed for a reason inside our control**, which is the distinction G1 turns on. Two real
bugs were found by running rather than by reading, and both are fixed:

1. A deposit needs `autoSetup: true` — a note cannot be created before its **token subchannel**
   exists. The mock pool's `Token <n> does not exist` is a *subchannel* assertion, not a missing
   ERC-20.
2. `ContractDiscoveryProvider` needs a typed pool `Contract`, not a `{ call() }` shim (D-008.5).
   This only surfaced against the live chain — mock mode passes either way, because `Mocknet`
   supplies its own pool object.

**Therefore G1 stays open.** PLAN.md's trigger for the Wallet-API fallback is "still red by end of
Day 3", and red means *our* code fails — not that a third party has not replied. `pnpm smoke:sepolia`
is wired and waiting; that run, not this one, decides G1.

### D-010 — Sepolia signer is generated by tooling, not by hand

The live run needs an `ACCOUNT_ADDRESS` / `ACCOUNT_PRIVATE_KEY` / `VIEWING_KEY` triple, and doing
that by hand is four fiddly steps. `scripts/gen-smoke-keys.ts` (`pnpm keys:gen`) does the two
mechanical ones and leaves the two that are genuinely the owner's.

Constraints it encodes, all of which are easy to get wrong by hand:

- **Viewing key range is `[1, MAX_VIEWING_KEY]` where `MAX_VIEWING_KEY = CURVE.n / 2`** — *half* the
  curve order. `randomPrivateKey()` overshoots roughly half the time, so the script uses rejection
  sampling (a modulus would skew the distribution, and this is key material). `resolveSigner` now
  rejects out-of-range keys too, turning a confusing failure deep inside the SDK into a config error.
- **Keys are written directly into `.env` and never printed.** Only the public account address
  reaches stdout — so the secrets never enter an agent transcript, by construction (hard rule 1).
- **Sepolia only.** Refuses to run when `KESE_NETWORK=mainnet`; mainnet key custody is the owner's.
- **Counterfactual address**, derived from the public key, so the account can be funded before it is
  deployed. The OpenZeppelin account class `0x061dac0…71b8f` is already declared on Sepolia
  (verified via `starknet_getClass`; its ABI confirms a single `public_key` constructor arg), so no
  declare step is needed.
- **Refuses to overwrite an existing signer** without `--force` — the old account may hold funds.

This account is a hot test key holding faucet funds. It is not to be reused anywhere real.

---

## Day 2 (Aug 21, 2026) — Phase A, policy core

### D-011 — A cap is an absolute ceiling, not a prompt

*Owner decision.* When an amount exceeds `perTxCap` or `dailyCap`, the engine **denies outright and
never raises an approval request**. The approval threshold only operates in the band *below* the
cap: under `approvalThreshold` → allow; between threshold and cap → ask a human; above the cap →
deny, full stop.

Rejected alternative: let a human approve past the cap. It reads as flexible, but it turns the cap
into a suggestion, and it hands a compromised agent an attack: fire large payments until a tired
owner taps Approve. A limit that can be talked past is not a limit. If a genuinely large payment is
needed, editing the policy is the right amount of friction — it is a deliberate act, not a
notification tapped at midnight.

Consequence for Phase B: the Telegram message never has to say "this is over your cap, approve
anyway?" — the only approvals that reach a human are ones the policy already considers legitimate.

### D-012 — `node:sqlite` instead of better-sqlite3 (revises D-003)

Node 24 ships `node:sqlite` (`DatabaseSync`) in core, verified working on v24.19.0. D-003 named
better-sqlite3, which is a native module needing node-gyp or a prebuilt binary.

**Decision:** use the built-in. Same synchronous, transactional API; one fewer dependency; nothing
to compile — which matters more than usual here, since we are already carrying one install
workaround (D-005) and the judges will run `pnpm install` on an unknown machine.

Two schema choices worth recording:

- **Amounts are `TEXT`, not `INTEGER`.** Token amounts run at 10^18, far past
  `Number.MAX_SAFE_INTEGER`. They are summed in JS as `bigint`; a SQL `SUM()` over these would
  coerce to float and lose precision — in a spending limit, of all places.
- **The store is synchronous throughout, deliberately.** The reserve path reads the rolling window
  and writes a reservation, and those must not interleave (hard rule 5). A synchronous body cannot
  be interrupted by the event loop, and `BEGIN IMMEDIATE` extends that to a second process. Adding
  an `await` inside a transaction would silently reopen the race — noted in the file header so it
  survives a future refactor.

### D-013 — Phase A acceptance: what the 44 policy tests actually pin down

`decide()` is deterministic and fully under test. Beyond the obvious cap/allowlist cases, the suite
pins three things that are easy to get wrong and invisible when wrong:

1. **Concurrency.** Ten parallel `decide()` calls against a cap that fits two grant exactly two.
   This passed the first time it ran, which is the point of writing it: it proves the
   synchronous-transaction design, rather than assuming it.
2. **Idempotency in the dangerous direction.** A replayed key returns the original decision *and*
   the original reservation. A key reused with a **different** request (bigger amount, different
   recipient) is denied — returning the stored `allow` there would authorise a payment nobody
   evaluated. Requests are fingerprinted by normalized content, so re-writing an address in padded
   form is not mistaken for a different request.
3. **Fail-closed on malformed input.** Address parsing throws on a hallucinated address; that
   exception used to escape `decide()`. A crash is not a denial, so every address now parses
   through `tryNormalizeAddress` and a bad one becomes `invalid_request`. Found by a test fixture
   using a non-hex "cute" address — worth keeping.

Also fixed along the way: config was looked up by string key, so a zero-padded token address fell
through to `token_not_configured` — a confusing denial for a token that *is* configured. Both the
allowlist and the cap lookups now compare addresses numerically.

---

## Intel triage — upstream issue #121 (Aug 21, 2026)

Three claims arrived from #121. Verified where verifiable rather than adopted on trust; one was
half-right, one is unverifiable but actionable, one we are deliberately not acting on.

### D-014 — `ContractDiscoveryProvider` IS exported — from `/testing`, not the package entry

**Claim:** "not exported in the published SDK (v0.14.3-rc.5); implement contract-based discovery
ourselves or abstract behind an interface."

**Verdict: half right — correct observation, wrong conclusion. No workaround needed.**

Checked against the actual published release commit `66e3caa`
(`chore(sdk): release 0.14.3-rc.5 (#943)`), not just our working copy:

| Import path | Present at rc.5 |
|---|---|
| `@starkware-libs/starknet-privacy-sdk` | **no** — 0 matches in `src/index.ts` |
| `@starkware-libs/starknet-privacy-sdk/testing` | **yes** — `src/testing/index.ts:35` |

`dist/testing/` ships in the tarball (`files: ["dist"]`, `exports["./testing"]`), and we already
use it against the **live Sepolia pool**: `pnpm smoke:simulate` returns `discoverRequirement →
Register (0)` and simulates a shield into 56 felts of `apply_actions`. Anyone importing from the
package root would see exactly what #121 saw. This is D-007, already logged — the standing action
is not to build a replacement but to re-decide before mainnet, since the vendor labels that subpath
dev/testing.

**However, #121 was right that something was wrong — just not this.** Chasing it exposed a real
defect in our own Phase S work.

### D-015 — Our vendored SDK was main HEAD, not the released rc.5 (fixed)

`scripts/vendor-sdk.sh` pinned `36eac4e`, which was main HEAD at clone time — **8 days and several
commits past** the rc.5 release. Its `package.json` still reads `0.14.3-rc.5` while its CHANGELOG
carries an `## Unreleased` section above it, so the artefact was labelled rc.5 and was not rc.5.

Not cosmetic: `src/internal/abi.ts` differs by 38 lines between the two — that is `PrivacyPoolABI`,
the ABI we build the typed pool `Contract` from. Post-rc.5 it gained open-note screening policies
and **retired the depositor block list**. Building a client ABI ahead of the deployed pool is how
you ship a call that compiles and then reverts.

**Fixed:** the script now pins `66e3caa`, the release commit, with the reasoning in a comment so
the next bump is deliberate. Verified after rebuilding: `get_open_note_screening_policy` is absent
from `PoolContractInterface` (it is a post-rc.5 addition), and all 71 tests, both typechecks and
both smoke modes stay green on the downgrade.

**Standing lesson:** vendoring pins a *commit*, and "latest main" is not "the version in
package.json". This is a second, independent reason to get `read:packages` and install the real
published tarball (D-005) — then there is nothing to get wrong.

### D-016 — ~24 STRK proving reserve: unverified, but guarded

**Claim:** proving transactions need roughly 24 STRK beyond `estimateInvokeFee`.

**Verdict: cannot verify** — it needs a proving service (#147), and it is second-hand. Adopting the
number as fact would be guessing; ignoring it would mean an agent that dies mid-burst with a raw
RPC revert.

**Built the guard, labelled the number.** `packages/core/src/fees.ts` exposes
`assessGasHeadroom()` with `DEFAULT_PROVING_GAS_RESERVE_STRK = 24 STRK`, overridable via
`PROVING_GAS_RESERVE_STRK` (0 disables). The smoke preflight now reports it:

```
✅ Gas headroom (STRK)   2999.9428 held, 24.1000 required (reserve 24.0000, unverified — #121)
```

The case worth testing is when the payment token *is* the gas token: reserve and amount compete for
the same balance, and checking them separately is what silently under-funds a burst. Six tests,
written first. Revise the constant once a real proof has actually been paid for.

**Funding consequence:** a mainnet signer needs the reserve on top of the amount to be shielded —
factor it into Phase M funding rather than discovering it at 2am on Day 8.

### D-017 — Alpha-sepolia endpoints from the app bundle: not adopted

**Claim:** proving/discovery endpoints for alpha-sepolia appear in the official app's JS bundle,
open CORS, usable status unconfirmed.

**Decision: do not hunt for them, do not hardcode them, and do not use them without the team
saying so.** Three reasons, in order of weight: their status is unconfirmed, so a green run against
them would prove nothing we could rely on; they are internal endpoints found by reading someone's
bundle, and the sanctioned channel for exactly this request (#147) is already open with our name on
it; and the team that operates them is the team judging the hackathon.

**No code change is needed to stay ready.** `PROVING_SERVICE_URL_SEPOLIA` is already an env var
resolved through `packages/core/src/config.ts` — if the team confirms a URL on #147 or #121, it is
a one-line `.env` edit and `pnpm smoke:sepolia` runs. Nothing is hardcoded today and nothing should
become hardcoded.

**Owner action:** if you want this unblocked sooner, ask on #147 whether the alpha-sepolia prover is
usable by hackathon teams. That is a question for you to ask, not for us to answer by pointing our
client at it.

### D-018 — MCP tool names are prefixed `kese_` (deviates from PLAN.md)

`PLAN.md` names the tools `get_balance`, `pay_private`, `withdraw`, … The Anthropic mcp-builder
skill calls for a service prefix, and here that is a safety argument rather than a style one: an
agent usually has several MCP servers connected, and a bare `withdraw` or `get_balance` is ambiguous
across them. The model resolves that ambiguity by guessing, and for a money tool a wrong guess moves
funds through the wrong wallet.

Shipped as `kese_pay_private`, `kese_withdraw`, `kese_get_balance`, `kese_create_claim_link`,
`kese_list_activity`, `kese_get_policy`. Reverting is a one-line change if the owner prefers the
original names.

### D-019 — Tool amounts are whole-token decimal strings, never base units

`amount: "1.5"` means 1.5 STRK. Asking a model to write `1500000000000000000` invites an
off-by-10^18, and the direction that survives is the one that **overpays** — only the caps would
stand in the way. The string is parsed as text (never through `Number`, where `0.1 * 1e18` is not
10^17) and scaled once, at the tool boundary. Scientific notation is rejected by the schema.

### D-020 — Execution idempotency is separate from decision idempotency

The policy engine makes `decide()` idempotent: a replayed key returns the original decision *and*
the original reservation. That alone is not enough — the caller would then execute the payment a
second time, since the reservation looks perfectly valid.

`spend()` therefore reads `reservationOutcome(reservationId)` before executing: `committed` returns
the stored receipt verbatim (`replayed: true`), `released` reports the earlier failure rather than
quietly retrying. Hard rule 3 is about execution, not just about deciding — and the gap between the
two is exactly where a double payment lives.

### D-021 — Two build defects found by actually running the server

Neither showed up in tests or typechecks, which is the point of running the thing:

1. **`outDir` lived in `tsconfig.base.json`**, and TypeScript resolves it relative to the file that
   declares it — so every package emitted into the repo root's `dist/`, each overwriting the last.
2. **`paths` in the shared base** made every downstream package compile `@kese/core`'s *source*
   rather than consume its build, which broke `rootDir` and would have shipped duplicate output.
   Package builds now resolve `@kese/core` through node_modules to `dist`; pnpm orders them
   correctly because the workspace dependency is declared. The path mapping survives only in
   `tsconfig.scripts.json` and `vitest.config.ts`, where source resolution is what is wanted.

### D-022 — Approvals: the owner check is the whole security model

A bot token identifies the *bot*, not a person. Anyone who learns the bot's handle can message it,
and a Telegram callback carries whatever chat it came from. Approving because "a callback arrived"
would hand payment authority to a stranger, so `callback_query.from.id` is compared against
`TELEGRAM_OWNER_CHAT_ID` on **every** update, before anything else is read.

Everything that is not an explicit owner approval denies: timeout, unknown ticket, duplicate press
on a resolved ticket, a send that never reached Telegram, a transport error. Silence is never
consent (hard rule 4). A failed *poll*, by contrast, keeps looping — that is a network blip, and
giving up there would strand every pending request; the timeout is what bounds the wait.

**Half-configured is treated as unconfigured.** A bot token with no owner chat id returns no channel
at all, because there is no safe chat to fall back to. No channel means every approval is denied,
never auto-approved — and the server says so loudly at startup.

**No dependency.** Telegram's Bot API is four HTTPS calls and Node 24 ships `fetch`. The project
already carries one dependency workaround (D-005); fewer moving parts in the path that authorises
payments is worth more than the convenience of a client library.

### D-023 — Restart recovery: the reservation outlives the promise

A restart mid-approval loses the promise `spend()` was awaiting, but **not** the policy reservation
that approval was holding. That budget would then stay held until the rolling 24h window slid past
it — invisibly, because nothing failed and nothing logged.

Tickets are therefore persisted with their `reservationId`, and the MCP server releases every
still-pending reservation at startup before serving a single tool. This is the reason the ticket
record exists at all; the audit history is a side benefit.

### D-024 — The runtime policy database was committed by mistake (fixed)

`kese-policy.sqlite` and its WAL files were swept into commit `2f59617` by a `git add -A`. It is
runtime state — a log of what the agent tried to spend — and has no business in the repository.
Untracked and added to `.gitignore` (`*.sqlite*`).

Two follow-ons: a unit test was constructing an approval store at the default `POLICY_DB_PATH` and
so writing to the operator's real database, now pinned to `:memory:`; and `git add -A` is the habit
that caused this, so prefer explicit paths when the working tree has untracked runtime files.

### D-025 — `simulated` is its own outcome, never reported as `paid`

Found while preparing the Telegram dry run, before it could mislead anyone. `spend()` treated any
non-`failed` receipt as success, so in simulate mode — the mode we are stuck in until #147 — a
payment that was compiled but **never submitted** came back as `status: "paid"`. An LLM told a
payment succeeded goes on to tell the user the invoice is settled. A dry run that lies is worse than
no dry run at all.

`simulated` is now a distinct outcome carrying an explicit "NOT submitted" reason, and it
**releases** its reservation: nothing moved, so holding the budget would make the caps drift away
from reality every time someone rehearses.

Worth noting how it surfaced — not from a test or a typecheck, but from asking "what will the owner
actually see when they run this?" before running it.

### D-026 — Approval messages are plain text, and "unreachable" is not "denied"

The first live Telegram dry run refused the payment and reported *"the owner denied this payment"*.
The owner had seen nothing at all. Two separate defects, both found only by running it against the
real API with a real phone:

**1. `parse_mode: "Markdown"` on data we do not control.** Telegram replied
`can't parse entities: Can't find end of the entity starting at byte offset 40` — byte 40 was the
underscore in `private_transfer`. Legacy Markdown reads `_` as italic, finds no closing one, and
rejects the *entire* message. An approval message carries action names, addresses and amounts that
we never get to sanitise, so any formatting mode is a liability: bold text is not worth a broken
approval. Now sent as plain text, with a regression test using the exact string that broke it.

**2. A failed send was reported as a denial.** `request()` returned `"denied"` when `sendMessage`
threw, and the spend pipeline rendered that as "the owner denied this payment". Both outcomes refuse
the payment, but only one is true — and the false one sends the operator hunting for a person who
never received anything, while a broken integration hides behind a plausible-looking policy outcome.
`ApprovalVerdict` gained `"unreachable"`, reported as *"the approval request could not be delivered,
so the owner was never asked"*.

The pattern is the same one D-025 caught an hour earlier, and worth naming: **the failure modes that
matter most here are the ones that produce a confident, wrong answer.** A crash is loud. "Paid" when
nothing was submitted, or "the owner denied" when the owner never saw it, are quiet — and both were
found by asking what a human would actually see, not by a test.
