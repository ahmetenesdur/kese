/**
 * DAY-1 SPIKE (Gate G1) — prove the STRK20 SDK route end-to-end.
 *
 * Flow under test: register → shield (deposit) → discoverNotes → private transfer → withdraw.
 *
 * Three modes, in increasing order of how much reality they touch:
 *
 *   --mode=mock       In-memory Mocknet (SDK's own MockPoolContract + MockProofProvider).
 *                     No chain, no keys, no proving service. Proves our *flow choreography*
 *                     is correct: builder chains, note selection, channel setup, ordering.
 *
 *   --mode=simulate   Live Sepolia RPC + the real deployed pool, but proofs come from the
 *                     SDK's internal mock prover via `.simulate({ node })`. Nothing is
 *                     submitted. Proves our *wiring against the live pool* — discovery,
 *                     note selection and calldata assembly all run against real state.
 *                     This is the highest fidelity reachable without a proving service.
 *
 *   --mode=service    The real thing: real proofs, real submission, real tx hashes.
 *                     Requires PROVING_SERVICE_URL_* (blocked on strk20-hackathon#147)
 *                     and a funded, deployed account.
 *
 * Whatever the mode, the script always runs a full preflight first and always writes a
 * machine-readable report. A blocked run is not a failed run — the point of Gate G1 is to
 * learn *precisely* what blocks and who can unblock it. See docs/decisions.md D-004..D-008.
 *
 * Usage:
 *   pnpm smoke:mock
 *   pnpm smoke:simulate
 *   pnpm smoke:sepolia            # --mode=service
 *   pnpm smoke -- --mode=simulate --amount=1000000000000000000 --token=STRK
 */

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { Account, Contract, RpcProvider } from "starknet";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  SetupRequirement,
  type Note,
  type PrivateTransfersInterface,
  type Proof,
  type ProofInvocation,
  type ProofProviderInterface,
  type ProvingBlockId,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  CallMockProofProvider,
  ContractDiscoveryProvider,
  IndexerDiscoveryProvider,
  Mocknet,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import {
  TOKENS,
  createRedactor,
  resolveNetwork,
  resolveNetworkConfig,
  resolveSigner,
  type NetworkConfig,
  type SignerConfig,
} from "../packages/core/src/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "mock" | "simulate" | "service";

/** Who can clear a blocker. Mirrors the split in CLAUDE.md ("what Enes handles"). */
type Owner = "claude" | "enes" | "upstream";

type CheckStatus = "ok" | "missing" | "fail";

interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Only set when status !== "ok". */
  owner?: Owner;
}

type StepStatus = "ok" | "blocked" | "failed" | "skipped";

interface Step {
  name: string;
  status: StepStatus;
  ms: number;
  detail: string;
  txHash?: string;
  /** Proving time in ms, isolated from submission/confirmation time. */
  proveMs?: number;
  /** Who can clear this, when status is "blocked". */
  owner?: Owner;
}

interface Report {
  startedAt: string;
  mode: Mode;
  network: string;
  sdkVersion: string;
  checks: Check[];
  steps: Step[];
  verdict: Verdict;
}

interface Verdict {
  gate: "PASS" | "PARTIAL" | "BLOCKED" | "FAIL";
  summary: string;
  blockers: { what: string; owner: Owner }[];
}

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { mode: Mode; amount: bigint; token: string; report: string } {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) flags.set(match[1]!, match[2] ?? "true");
  }

  const rawMode = flags.get("mode") ?? process.env.PROVING_MODE ?? "mock";
  if (rawMode !== "mock" && rawMode !== "simulate" && rawMode !== "service") {
    throw new Error(`--mode must be one of mock | simulate | service (got "${rawMode}")`);
  }

  return {
    mode: rawMode,
    // 0.1 STRK by default — small enough to be safe, round enough not to fingerprint (notes §8).
    amount: BigInt(flags.get("amount") ?? process.env.SMOKE_AMOUNT ?? "100000000000000000"),
    token: flags.get("token") ?? process.env.SMOKE_TOKEN ?? "STRK",
    report: flags.get("report") ?? "smoke-report.json",
  };
}

function loadEnv(): void {
  // Node >= 24 built-in; avoids a dotenv dependency.
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env is a legitimate state (CI, mock mode) — preflight reports what's missing.
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const ICON: Record<CheckStatus | StepStatus, string> = {
  ok: "✅",
  missing: "⚠️ ",
  fail: "❌",
  blocked: "⛔",
  failed: "❌",
  skipped: "⏭️ ",
};

function heading(text: string): void {
  console.log(`\n${"─".repeat(72)}\n${text}\n${"─".repeat(72)}`);
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

// ---------------------------------------------------------------------------
// Proof-provider decorator — isolates proving time from submission time
// ---------------------------------------------------------------------------

/**
 * Wraps any ProofProviderInterface to record how long each `prove()` call takes.
 *
 * "Measure: proof time, failure modes" is half of the Phase S task, and proving time is
 * otherwise buried inside `execute()` alongside discovery and calldata assembly.
 */
class TimedProofProvider implements ProofProviderInterface {
  readonly timings: number[] = [];

  constructor(private readonly inner: ProofProviderInterface) {}

  getDefaultDetails() {
    return this.inner.getDefaultDetails();
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const started = performance.now();
    try {
      return await this.inner.prove(invocation, blockIdentifier);
    } finally {
      this.timings.push(performance.now() - started);
    }
  }

  invalidateNonceCache(): void {
    this.inner.invalidateNonceCache?.();
  }

  /** ms spent proving since the last call, or undefined if nothing was proven. */
  lastTiming(): number | undefined {
    return this.timings.at(-1);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflight(mode: Mode, tokenSymbol: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => {
    checks.push(check);
    const owner = check.status === "ok" ? "" : `  [unblocked by: ${check.owner ?? "?"}]`;
    console.log(`${ICON[check.status]} ${check.label.padEnd(30)} ${check.detail}${owner}`);
  };

  // --- toolchain ---
  const major = Number(process.versions.node.split(".")[0]);
  add({
    id: "node",
    label: "Node >= 24",
    status: major >= 24 ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    owner: "enes",
  });

  const sdkVersion = await readSdkVersion();
  add({
    id: "sdk",
    label: "Privacy SDK importable",
    status: sdkVersion ? "ok" : "fail",
    detail: sdkVersion ? `@starkware-libs/starknet-privacy-sdk@${sdkVersion}` : "import failed",
    owner: "enes",
  });

  // mock mode is self-contained — everything below is about the live chain.
  if (mode === "mock") {
    add({
      id: "mode",
      label: "Mode",
      status: "ok",
      detail: "mock — in-memory pool, no chain/keys/proving needed",
    });
    return checks;
  }

  // --- network config ---
  const network = resolveNetwork();
  const net = resolveNetworkConfig();
  add({
    id: "network-config",
    label: `Network config (${network})`,
    status: net.value ? "ok" : "missing",
    detail: net.value ? `pool ${short(net.value.poolAddress)}` : `missing: ${net.missing.join(", ")}`,
    owner: "enes",
  });
  if (!net.value) return checks;

  // --- RPC reachability + chain identity ---
  const provider = new RpcProvider({ nodeUrl: net.value.rpcUrl });
  let head: number | null = null;
  try {
    const [chainId, blockNumber, specVersion] = await Promise.all([
      provider.getChainId(),
      provider.getBlockNumber(),
      provider.getSpecVersion(),
    ]);
    head = blockNumber;
    const chainMatches = chainId === net.value.chainId;
    add({
      id: "rpc",
      label: "RPC reachable",
      status: chainMatches ? "ok" : "fail",
      detail: chainMatches
        ? `block ${blockNumber}, spec ${specVersion}`
        : `chain mismatch: node says ${chainId}, KESE_NETWORK implies ${net.value.chainId}`,
      owner: "enes",
    });
  } catch (error) {
    add({ id: "rpc", label: "RPC reachable", status: "fail", detail: redact(error), owner: "enes" });
    return checks;
  }

  // --- pool contract actually deployed at the documented address ---
  await probeContract(provider, net.value.poolAddress, {
    id: "pool",
    label: "Pool contract deployed",
    owner: "enes",
    add,
  });

  // --- token ---
  const tokenAddress = resolveToken(net.value, tokenSymbol);
  if (!tokenAddress) {
    add({
      id: "token",
      label: `Token ${tokenSymbol}`,
      status: "missing",
      detail: `unknown symbol; pass --token=0x... or add it to TOKENS in packages/core/src/config.ts`,
      owner: "claude",
    });
  } else {
    await probeContract(provider, tokenAddress, {
      id: "token",
      label: `Token ${tokenSymbol} deployed`,
      owner: "enes",
      add,
    });
  }

  // --- signer ---
  const signer = resolveSigner();
  add({
    id: "signer",
    label: "Signer configured",
    status: signer.value ? "ok" : "missing",
    // Address is public; the key and viewing key never appear.
    detail: signer.value
      ? `account ${short(signer.value.address)}, viewing key parsed as bigint`
      : `missing: ${signer.missing.join(", ")}`,
    owner: "enes",
  });

  if (signer.value) {
    await probeContract(provider, signer.value.address, {
      id: "account-deployed",
      label: "Account deployed",
      owner: "enes",
      add,
    });

    if (tokenAddress) {
      try {
        const balance = await erc20Balance(provider, tokenAddress, signer.value.address);
        add({
          id: "balance",
          label: `${tokenSymbol} balance`,
          status: balance > 0n ? "ok" : "missing",
          detail: balance > 0n ? `${formatUnits(balance)} ${tokenSymbol}` : "zero — fund the account",
          owner: "enes",
        });
      } catch (error) {
        add({
          id: "balance",
          label: `${tokenSymbol} balance`,
          status: "fail",
          detail: redact(error),
          owner: "enes",
        });
      }
    }
  }

  // --- proving service (the known blocker) ---
  if (mode === "service") {
    const url = net.value.provingServiceUrl;
    if (!url) {
      add({
        id: "proving",
        label: "Proving service URL",
        status: "missing",
        detail: `PROVING_SERVICE_URL_${network.toUpperCase()} unset — awaiting strk20-hackathon#147`,
        owner: "upstream",
      });
    } else {
      add({
        id: "proving",
        label: "Proving service URL",
        status: "ok",
        detail: url.replace(/\/+$/, ""),
      });
    }
  } else {
    add({
      id: "proving",
      label: "Proving service URL",
      status: "ok",
      detail: "not required in simulate mode (SDK mock prover)",
    });
  }

  // --- proving block depth: head must be >= 10 for provingBlockId to exist at all ---
  if (head != null) {
    add({
      id: "proving-depth",
      label: "Proving block available",
      status: head > 10 ? "ok" : "fail",
      detail: `provingBlockId = ${head - 10} (head ${head} − 10)`,
      owner: "enes",
    });
  }

  return checks;
}

async function probeContract(
  provider: RpcProvider,
  address: string,
  opts: { id: string; label: string; owner: Owner; add: (check: Check) => void }
): Promise<void> {
  try {
    const classHash = await provider.getClassHashAt(address, "latest");
    opts.add({
      id: opts.id,
      label: opts.label,
      status: "ok",
      detail: `class ${short(classHash)}`,
    });
  } catch (error) {
    opts.add({
      id: opts.id,
      label: opts.label,
      status: "fail",
      detail: `${short(address)} — ${redact(error).split("\n")[0]}`,
      owner: opts.owner,
    });
  }
}

async function erc20Balance(
  provider: RpcProvider,
  token: string,
  account: string
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: token,
    entrypoint: "balanceOf",
    calldata: [account],
  });
  // u256 → [low, high]
  const [low = "0x0", high = "0x0"] = result;
  return BigInt(low) + (BigInt(high) << 128n);
}

// ---------------------------------------------------------------------------
// Mode: mock — in-memory pool, full four-step flow
// ---------------------------------------------------------------------------

async function runMock(amount: bigint): Promise<Step[]> {
  const steps: Step[] = [];
  const mocknet = new Mocknet();
  const env = mocknet.initialize();

  // Mocknet funds every account with 1000n of each mock token; scale the smoke amount down
  // to fit rather than pretending 0.1 STRK means something against a mock ledger.
  const mockAmount = amount > 500n ? 100n : amount;
  const token = env.ace;

  const alice = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey);
  const bob = mocknet.createPrivateTransfers(env.bob.address, env.bob.privateKey);
  const aliceAddress = hex(env.alice.address);
  const bobAddress = hex(env.bob.address);

  // 1. Register — both sides must hold a published viewing key before a private transfer
  //    can be routed (notes §5), so the recipient is registered here too.
  await step(steps, "register (alice)", async () => {
    mocknet.executeOutside(await alice.build().register().execute());
    return "viewing key published";
  });
  await step(steps, "register (bob)", async () => {
    mocknet.executeOutside(await bob.build().register().execute());
    return "recipient registered";
  });

  // 2. Shield — public edge: the deposit itself is visible, privacy starts after (notes §8).
  await step(steps, "shield (deposit)", async () => {
    const result = await alice
      .build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
      .with(token, (t) => t.deposit({ amount: mockAmount }))
      .surplusTo(aliceAddress)
      .execute();
    mocknet.executeOutside(result);
    return `${mockAmount} shielded`;
  });

  // 3. Discover — the shielded balance should now be visible as notes to the viewing key.
  let notes: Note[] = [];
  await step(steps, "discoverNotes", async () => {
    // The Mocknet class narrows discoverNotes() — no token filter, so filter the map instead.
    const discovered = await alice.discoverNotes();
    notes = discovered.notes.get(BigInt(token)) ?? [];
    const total = notes.reduce((sum, note) => sum + note.amount, 0n);
    if (notes.length === 0) throw new Error("no notes discovered after deposit");
    return `${notes.length} note(s), total ${total}`;
  });

  // 4. Private transfer — sender, recipient and amount all hidden in-pool.
  const transferAmount = mockAmount / 2n;
  await step(steps, "private transfer", async () => {
    const result = await alice
      .build({
        autoSetup: true,
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(token, (t) => t.transfer({ recipient: bobAddress, amount: transferAmount }))
      .surplusTo(aliceAddress)
      .execute();
    mocknet.executeOutside(result);
    return `${transferAmount} → bob`;
  });

  // 5. Recipient-side check — a transfer nobody can see is only useful if the recipient can.
  await step(steps, "recipient sees note", async () => {
    const discovered = await bob.discoverNotes();
    const bobNotes = discovered.notes.get(BigInt(token)) ?? [];
    const total = bobNotes.reduce((sum, note) => sum + note.amount, 0n);
    if (total !== transferAmount) {
      throw new Error(`bob has ${total}, expected ${transferAmount}`);
    }
    return `${bobNotes.length} note(s), total ${total}`;
  });

  // 6. Withdraw — the other public edge.
  await step(steps, "withdraw", async () => {
    const withdrawAmount = transferAmount / 2n;
    const result = await alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(token, (t) => t.withdraw({ recipient: aliceAddress, amount: withdrawAmount }))
      .surplusTo(aliceAddress)
      .execute();
    mocknet.executeOutside(result);
    return `${withdrawAmount} → public balance`;
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Modes: simulate / service — live chain
// ---------------------------------------------------------------------------

interface LiveContext {
  mode: Mode;
  net: NetworkConfig;
  signer: SignerConfig;
  provider: RpcProvider;
  account: Account;
  transfers: PrivateTransfersInterface;
  prover: TimedProofProvider | null;
  token: string;
  amount: bigint;
  recipient: string;
}

function buildLiveContext(
  mode: Mode,
  net: NetworkConfig,
  signer: SignerConfig,
  token: string,
  amount: bigint
): LiveContext {
  const provider = new RpcProvider({ nodeUrl: net.rpcUrl });
  const account = new Account({
    provider,
    address: signer.address,
    signer: signer.privateKey,
    cairoVersion: "1",
  });

  // Discovery: the indexer is optional. Without one we go straight at the pool over RPC —
  // slower, but zero external dependencies (docs/decisions.md D-001).
  const discoveryProvider = net.indexerUrl
    ? new IndexerDiscoveryProvider(net.indexerUrl, net.poolAddress)
    : new ContractDiscoveryProvider(poolContractFor(provider, net.poolAddress));

  // `.simulate()` builds its OWN mock prover internally and never calls prove() on ours — but it
  // still asks the configured provider for getDefaultDetails() (pool nonce, chainId) while
  // compiling the invocation. So simulate mode needs a provider that answers that much.
  // CallMockProofProvider is the SDK's own: it runs the invocation through the node's transaction
  // simulation and captures what the pool would have emitted, instead of generating a proof.
  const prover =
    mode === "service" && net.provingServiceUrl
      ? new TimedProofProvider(
          new ProvingServiceProofProvider(net.provingServiceUrl, net.chainId, {
            nodeUrl: net.rpcUrl,
            poolAddress: net.poolAddress,
          })
        )
      : null;

  const provingProvider =
    prover ?? (mode === "simulate" ? new CallMockProofProvider(provider, net.chainId) : unavailableProver());

  const transfers = createPrivateTransfers({
    account,
    // MUST be bigint — a hex string here silently misbehaves (notes §2).
    viewingKeyProvider: { getViewingKey: async () => signer.viewingKey },
    provingProvider,
    discoveryProvider,
    poolContractAddress: net.poolAddress,
  });

  return { mode, net, signer, provider, account, transfers, prover, token, amount, recipient: recipientFor(signer) };
}

/**
 * Fail-closed placeholder (hard rule 4): in simulate mode nothing should ever reach the
 * prover. If something does, we want a loud, specific error rather than a silent fallback.
 */
function unavailableProver(): ProofProviderInterface {
  const fail = (): never => {
    throw new Error(
      "Proving service is not configured. Run with --mode=simulate, or set " +
        "PROVING_SERVICE_URL_* once strk20-hackathon#147 is answered."
    );
  };
  return { getDefaultDetails: fail, prove: fail };
}

function recipientFor(signer: SignerConfig): string {
  // A second registered account is ideal; self-transfer still exercises the whole private
  // path (the SDK classifies it as `transferSelf`) and needs no second funded wallet.
  return process.env.SMOKE_RECIPIENT_ADDRESS?.trim() || signer.address;
}

async function runLive(ctx: LiveContext): Promise<Step[]> {
  const steps: Step[] = [];
  const tokenBig = BigInt(ctx.token);

  // Readiness is a read-only question — it works identically in both live modes and tells
  // us what the pool thinks is still missing before we spend anything on proving.
  await step(steps, "discoverRequirement", async () => {
    const requirement = await ctx.transfers.discoverRequirement(ctx.recipient, ctx.token);
    return `${SetupRequirement[requirement]} (${requirement})`;
  });

  let shieldedBalance = 0n;
  await step(steps, "discoverNotes", async () => {
    const { notes } = await ctx.transfers.discoverNotes({ tokens: [tokenBig] });
    const found = notes.get(tokenBig) ?? [];
    shieldedBalance = found.reduce((sum, note) => sum + note.amount, 0n);
    return `${found.length} note(s), total ${shieldedBalance}`;
  });

  if (ctx.mode === "simulate") {
    await runSimulateSteps(ctx, steps, shieldedBalance);
  } else {
    await runServiceSteps(ctx, steps);
  }

  return steps;
}

/**
 * Simulate mode: compile each action against live pool state, stop before submission.
 *
 * Each step is independent — simulation does not mutate the chain, so the transfer step does not
 * see notes the shield step would have created. That is the honest limit of this mode: it
 * validates wiring and calldata, not sequencing.
 *
 * The practical consequence: the spending steps need notes that already exist on-chain. With an
 * empty shielded balance they are *not applicable*, not broken — so they are skipped with a
 * reason rather than reported as failures. Anything else would make a healthy day-1 run look red.
 */
async function runSimulateSteps(
  ctx: LiveContext,
  steps: Step[],
  shieldedBalance: bigint
): Promise<void> {
  const provingBlockId = await provingBlock(ctx.provider);

  await step(steps, "shield (simulated)", async () => {
    const { callAndProof } = await ctx.transfers
      .build({ autoRegister: true, autoSetup: true, autoDiscover: { notes: "refresh" }, provingBlockId })
      .with(ctx.token, (t) => t.deposit({ amount: ctx.amount }))
      .surplusTo(ctx.signer.address)
      .simulate({ node: ctx.provider });
    return `calldata ${callAndProof.call.calldata?.length ?? 0} felts → ${callAndProof.call.entrypoint}`;
  });

  if (shieldedBalance < ctx.amount) {
    const why =
      `needs ${ctx.amount} shielded, have ${shieldedBalance} — simulate() does not mutate state, ` +
      `so the shield above created nothing on-chain. Runs once --mode=service lands a deposit.`;
    notApplicable(steps, "private transfer (simulated)", why);
    notApplicable(steps, "withdraw (simulated)", why);
    return;
  }

  await step(steps, "private transfer (simulated)", async () => {
    const { callAndProof } = await ctx.transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
        provingBlockId,
      })
      .with(ctx.token, (t) => t.transfer({ recipient: ctx.recipient, amount: ctx.amount }))
      .surplusTo(ctx.signer.address)
      .simulate({ node: ctx.provider });
    return `calldata ${callAndProof.call.calldata?.length ?? 0} felts → ${callAndProof.call.entrypoint}`;
  });

  await step(steps, "withdraw (simulated)", async () => {
    const { callAndProof } = await ctx.transfers
      .build({
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
        provingBlockId,
      })
      .with(ctx.token, (t) => t.withdraw({ recipient: ctx.signer.address, amount: ctx.amount }))
      .surplusTo(ctx.signer.address)
      .simulate({ node: ctx.provider });
    return `calldata ${callAndProof.call.calldata?.length ?? 0} felts → ${callAndProof.call.entrypoint}`;
  });
}

/** Service mode: real proofs, real submission, real tx hashes for strk20.json. */
async function runServiceSteps(ctx: LiveContext, steps: Step[]): Promise<void> {
  let lastTxBlock: number | null = null;

  const submit = async (label: string, build: (provingBlockId: ProvingBlockId) => Promise<{
    callAndProof: { call: Parameters<Account["execute"]>[0]; proof: { proofFacts: string[]; data: string } };
  }>) =>
    step(steps, label, async () => {
      // Every proof must sit at least 10 blocks behind the head, and the previous private tx
      // must be that far behind too before its state is provable (SDK README, "Sequencing").
      if (lastTxBlock != null) await waitForDepth(ctx.provider, lastTxBlock);
      const provingBlockId = await provingBlock(ctx.provider);

      const { callAndProof } = await build(provingBlockId);

      const fee = await ctx.account.estimateInvokeFee(callAndProof.call, {
        proofFacts: callAndProof.proof.proofFacts,
        proof: callAndProof.proof.data,
      });
      const tx = await ctx.account.execute(callAndProof.call, {
        tip: 0n, // v3 transactions require this (notes §4)
        resourceBounds: fee.resourceBounds,
        proofFacts: callAndProof.proof.proofFacts,
        proof: callAndProof.proof.data,
      });
      const receipt = await ctx.provider.waitForTransaction(tx.transaction_hash);
      if (!receipt.isSuccess()) {
        throw new Error(`reverted: ${(receipt as { revert_reason?: string }).revert_reason ?? "unknown"}`);
      }
      lastTxBlock = (receipt as unknown as { block_number: number }).block_number;
      return { detail: `block ${lastTxBlock}`, txHash: tx.transaction_hash, proveMs: ctx.prover?.lastTiming() };
    });

  await submit("register", async (provingBlockId) =>
    ctx.transfers.build().register().execute({ provingBlockId })
  );

  // The pool pulls the deposit, so it needs an allowance first. This is a transparent tx —
  // and by the same 10-block rule its effect must settle before the deposit proof reads it.
  await step(steps, "approve pool (transparent)", async () => {
    const call = {
      contractAddress: ctx.token,
      entrypoint: "approve",
      calldata: [ctx.net.poolAddress, `0x${ctx.amount.toString(16)}`, "0x0"],
    };
    const fee = await ctx.account.estimateInvokeFee(call);
    const tx = await ctx.account.execute(call, { tip: 0n, resourceBounds: fee.resourceBounds });
    const receipt = await ctx.provider.waitForTransaction(tx.transaction_hash);
    if (!receipt.isSuccess()) throw new Error("approve reverted");
    lastTxBlock = (receipt as unknown as { block_number: number }).block_number;
    return { detail: `allowance set`, txHash: tx.transaction_hash };
  });

  await submit("shield (deposit)", async (provingBlockId) =>
    ctx.transfers
      .build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" }, provingBlockId })
      .with(ctx.token, (t) => t.deposit({ amount: ctx.amount }))
      .surplusTo(ctx.signer.address)
      .execute({ provingBlockId })
  );

  const half = ctx.amount / 2n;
  await submit("private transfer", async (provingBlockId) =>
    ctx.transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
        provingBlockId,
      })
      .with(ctx.token, (t) => t.transfer({ recipient: ctx.recipient, amount: half }))
      .surplusTo(ctx.signer.address)
      .execute({ provingBlockId })
  );

  await submit("withdraw", async (provingBlockId) =>
    ctx.transfers
      .build({
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
        provingBlockId,
      })
      .with(ctx.token, (t) => t.withdraw({ recipient: ctx.signer.address, amount: half / 2n }))
      .surplusTo(ctx.signer.address)
      .execute({ provingBlockId })
  );
}

/** provingBlockId is always head − 10: note maturity, reorg buffer, state consistency. */
async function provingBlock(provider: RpcProvider): Promise<number> {
  return (await provider.getBlockNumber()) - 10;
}

/** Block until `sinceBlock` is at least 10 blocks behind the head. */
async function waitForDepth(provider: RpcProvider, sinceBlock: number, depth = 10): Promise<void> {
  let head = await provider.getBlockNumber();
  while (sinceBlock >= head - depth) {
    process.stdout.write(`\r   waiting for depth: ${head - sinceBlock}/${depth} blocks…   `);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    head = await provider.getBlockNumber();
  }
  process.stdout.write("\r".padEnd(50) + "\r");
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

type StepOutcome = string | { detail: string; txHash?: string; proveMs?: number };

/**
 * Record a step that was deliberately not run because its precondition does not hold.
 *
 * Distinct from the cascade-skip inside `step()`: nothing went wrong here, so this must not
 * colour the gate verdict. Reported, never hidden.
 */
function notApplicable(steps: Step[], name: string, reason: string): void {
  steps.push({ name, status: "skipped", ms: 0, detail: reason });
  console.log(`${ICON.skipped} ${name.padEnd(30)} n/a — ${reason}`);
}

async function step(steps: Step[], name: string, run: () => Promise<StepOutcome>): Promise<void> {
  // Fail closed: once a step fails the chain of state it produces is gone, so everything
  // downstream is reported as skipped rather than attempted against unknown state.
  if (steps.some((s) => s.status === "failed" || s.status === "blocked")) {
    steps.push({ name, status: "skipped", ms: 0, detail: "upstream step did not complete" });
    console.log(`${ICON.skipped} ${name.padEnd(30)} skipped`);
    return;
  }

  const started = performance.now();
  try {
    const outcome = await run();
    const elapsed = performance.now() - started;
    const normalized = typeof outcome === "string" ? { detail: outcome } : outcome;
    steps.push({ name, status: "ok", ms: elapsed, ...normalized });
    const prove = normalized.proveMs ? ` (prove ${ms(normalized.proveMs)})` : "";
    console.log(`${ICON.ok} ${name.padEnd(30)} ${normalized.detail} — ${ms(elapsed)}${prove}`);
  } catch (error) {
    const elapsed = performance.now() - started;
    const message = redact(error);
    const blocked = isBlocked(message);
    steps.push({
      name,
      status: blocked ? "blocked" : "failed",
      ms: elapsed,
      detail: message.split("\n")[0]!,
      ...(blocked ? { owner: "upstream" as Owner } : {}),
    });
    console.log(`${ICON[blocked ? "blocked" : "failed"]} ${name.padEnd(30)} ${message.split("\n")[0]}`);
  }
}

/** A missing prerequisite is "blocked" (someone must act); anything else is a real failure. */
function isBlocked(message: string): boolean {
  return /Proving service is not configured|not published|ECONNREFUSED|ENOTFOUND|401|403/i.test(
    message
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Gate G1 decision (PLAN.md: "Apply without sentiment").
 *
 * PASS     — the full flow completed with real proofs on a real chain.
 * PARTIAL  — everything we control works; only externally-owned prerequisites are missing.
 * BLOCKED  — nothing could be attempted; a prerequisite is missing before the first step.
 * FAIL     — a step failed for a reason inside our control. This is the one that burns days.
 */
function assessGate(mode: Mode, checks: Check[], steps: Step[]): Verdict {
  const blockers = checks
    .filter((c) => c.status !== "ok")
    .map((c) => ({ what: `${c.label}: ${c.detail}`, owner: c.owner ?? ("enes" as Owner) }));

  for (const s of steps.filter((s) => s.status === "blocked")) {
    // The pre-flow guard re-states a prerequisite a check already reported. Both name the
    // same env vars, so if this step's vars are already covered, it isn't a second blocker.
    const vars = envVarsIn(s.detail);
    const covered =
      vars.length > 0 &&
      blockers.some((b) => {
        const seen = new Set(envVarsIn(b.what));
        return vars.every((v) => seen.has(v));
      });
    if (!covered) blockers.push({ what: `${s.name}: ${s.detail}`, owner: s.owner ?? "upstream" });
  }

  const failed = steps.filter((s) => s.status === "failed");
  const completed = steps.filter((s) => s.status === "ok").length;

  if (failed.length > 0) {
    return {
      gate: "FAIL",
      summary: `${failed.length} step(s) failed for reasons inside our control: ${failed
        .map((s) => s.name)
        .join(", ")}. Debug before spending another day (PLAN.md G1).`,
      blockers,
    };
  }

  if (completed === 0) {
    return { gate: "BLOCKED", summary: "No step could be attempted.", blockers };
  }

  if (mode === "service" && blockers.length === 0) {
    return {
      gate: "PASS",
      summary: `Full SDK route verified end-to-end with real proofs (${completed} steps).`,
      blockers,
    };
  }

  return {
    gate: "PARTIAL",
    summary:
      `${completed} step(s) passed in ${mode} mode with no failures inside our control. ` +
      `Remaining blockers are externally owned — G1 stays open, do not pivot yet.`,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let redact: (input: unknown) => string = (input) => String(input);

/** SCREAMING_SNAKE tokens (env var names) mentioned in a blocker message. */
function envVarsIn(text: string): string[] {
  return text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
}

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function formatUnits(value: bigint, decimals = 18): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function resolveToken(net: NetworkConfig, symbol: string): string | null {
  if (symbol.startsWith("0x")) return symbol;
  return TOKENS[net.network][symbol.toUpperCase()] ?? null;
}

/**
 * ContractDiscoveryProvider takes a pool *contract*, not an address — and specifically a
 * starknet.js Contract typed against the SDK's own ABI, because it calls the pool's view methods
 * by name (`get_public_key`, `get_note`, `channel_exists`, …). A generic `{ call() }` shim does
 * not satisfy that: it typechecks through a cast and then dies at runtime on the first view call.
 */
function poolContractFor(provider: RpcProvider, poolAddress: string) {
  return new Contract({
    abi: PrivacyPoolABI,
    address: poolAddress,
    providerOrAccount: provider,
  }).typedv2(PrivacyPoolABI) as unknown as ConstructorParameters<
    typeof ContractDiscoveryProvider
  >[0];
}

async function readSdkVersion(): Promise<string | null> {
  try {
    // The SDK is ESM-only: its exports map has no "require" condition and no
    // "./package.json" entry, so createRequire().resolve() throws. import.meta.resolve
    // uses the "import" condition and gives us the real entry point.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const entry = fileURLToPath(import.meta.resolve("@starkware-libs/starknet-privacy-sdk"));
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")
    ) as { version: string };
    return pkg.version;
  } catch {
    try {
      await import("@starkware-libs/starknet-privacy-sdk");
      return "unknown";
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  redact = createRedactor();

  const { mode, amount, token, report: reportPath } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  heading(`Kese — Day-1 STRK20 smoke test  ·  mode=${mode}`);
  const checks = await preflight(mode, token);

  heading("Flow");
  let steps: Step[] = [];

  if (mode === "mock") {
    steps = await runMock(amount);
  } else {
    const net = resolveNetworkConfig();
    const signer = resolveSigner();
    const tokenAddress = net.value ? resolveToken(net.value, token) : null;
    const provingReady = mode === "simulate" || Boolean(net.value?.provingServiceUrl);

    if (!net.value || !signer.value || !tokenAddress || !provingReady) {
      const [reason, owner]: [string, Owner] = !net.value
        ? [`network config incomplete (${net.missing.join(", ")})`, "enes"]
        : !signer.value
          ? [`signer not configured (${signer.missing.join(", ")})`, "enes"]
          : !tokenAddress
            ? [`unknown token "${token}"`, "claude"]
            : [`PROVING_SERVICE_URL_${resolveNetwork().toUpperCase()} unset`, "upstream"];
      steps = [{ name: "live flow", status: "blocked", ms: 0, detail: reason, owner }];
      console.log(`${ICON.blocked} live flow${" ".repeat(22)}${reason}`);
    } else {
      steps = await runLive(buildLiveContext(mode, net.value, signer.value, tokenAddress, amount));
    }
  }

  const verdict = assessGate(mode, checks, steps);

  heading(`Gate G1: ${verdict.gate}`);
  console.log(verdict.summary);
  if (verdict.blockers.length > 0) {
    console.log("\nBlockers:");
    for (const blocker of verdict.blockers) {
      console.log(`  · [${blocker.owner}] ${blocker.what}`);
    }
  }

  const proveTimings = steps.map((s) => s.proveMs).filter((v): v is number => v != null);
  if (proveTimings.length > 0) {
    const avg = proveTimings.reduce((a, b) => a + b, 0) / proveTimings.length;
    console.log(
      `\nProving: ${proveTimings.length} proof(s), avg ${ms(avg)}, max ${ms(Math.max(...proveTimings))}`
    );
  }

  const fullReport: Report = {
    startedAt,
    mode,
    network: resolveNetwork(),
    sdkVersion: (await readSdkVersion()) ?? "unavailable",
    checks,
    steps,
    verdict,
  };
  // Report contains addresses, tx hashes and timings only — never key material.
  writeFileSync(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`);
  console.log(`\nReport written to ${reportPath}`);

  // Exit non-zero only on failures we own — a blocked run is expected on Day 1.
  process.exitCode = verdict.gate === "FAIL" ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nFATAL: ${redact(error)}`);
  process.exitCode = 1;
});
