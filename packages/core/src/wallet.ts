/**
 * KeseWallet — the money-moving primitive.
 *
 * This is deliberately dumb about policy. Caps, allowlists and approvals live in `@kese/policy`,
 * and the MCP layer is what wires `decide()` in front of these calls (CLAUDE.md hard rule 2).
 * A wallet that also enforced limits would give the two layers two chances to disagree.
 *
 * Two rules are baked into the shape of this API rather than left to callers:
 *
 * 1. **No shield-and-pay convenience method, ever.** Bundling a deposit with the transfer it funds
 *    publishes "this address deposited X" in the same transaction as the transfer it paid for, and
 *    an observer correlates them trivially — the recipient stays hidden, the sender and amount do
 *    not. Shielding must be its own earlier transaction. If someone later wants one call that does
 *    both, that is a privacy regression, not a convenience.
 * 2. **Failures come back as receipts, not exceptions.** Every caller is on a money path that has
 *    already reserved budget and must release it; a thrown error makes that a try/catch each caller
 *    has to remember. `Receipt.status === "failed"` makes it part of the return type.
 *
 * Everything on the failure path goes through `redact` before it lands in a receipt, because a
 * receipt is headed for an MCP tool result — that is, straight into an LLM's context.
 */

import type {
  ExecuteOptions,
  ExecuteResult,
  PrivateTransfersInterface,
  SimulateOptions,
} from "@starkware-libs/starknet-privacy-sdk";
import type { ProviderInterface } from "starknet";
import { escrowDepositCalldata } from "./escrow.js";

export interface Receipt {
  status: "confirmed" | "simulated" | "failed";
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

/**
 * How a compiled transaction reaches the world.
 *
 * This is the one seam that genuinely differs between a chain and a test: everything above it —
 * builder, compiler, note selection, channel setup — is the SDK's real code in both cases. Keeping
 * it injected is what lets the test suite exercise the real pipeline without a prover.
 */
export interface Submitter {
  submit(result: ExecuteResult): Promise<{ txHash?: string; blockNumber?: number }>;
  /** Current chain head, used to derive the proving block. */
  head(): Promise<number>;
}

/**
 * The tail of a builder chain. Both the top-level builder and the per-token sub-builder expose
 * `execute` and `simulate`, so this is matched structurally rather than by naming one of them.
 */
interface Executable {
  execute(options?: ExecuteOptions): Promise<ExecuteResult>;
  simulate(options: SimulateOptions & ExecuteOptions): Promise<ExecuteResult>;
}

export interface KeseWalletDeps {
  transfers: PrivateTransfersInterface;
  /** This wallet's own account address — surplus and change come back here. */
  address: string;
  submitter: Submitter;
  redact: (input: unknown) => string;
  /**
   * Set to run in SIMULATE mode: every action is compiled against live pool state and checked by
   * the node, but nothing is submitted and no real proof is produced. Receipts come back as
   * `simulated`, never `confirmed` — the distinction has to survive all the way to the caller, or
   * a dry run reads like a successful payment.
   */
  simulateNode?: ProviderInterface;
  /** Deployed escrow-claim contract. Absent means claim links are unavailable, not silently skipped. */
  escrowAddress?: string;
}

export interface KeseWallet {
  register(): Promise<Receipt>;
  /** PUBLIC edge: the depositing address and amount are visible on-chain, and screened. */
  shield(token: string, amount: bigint): Promise<Receipt>;
  payPrivate(token: string, amount: bigint, recipient: string): Promise<Receipt>;
  /** PUBLIC edge: the recipient address and amount are visible on-chain. */
  withdraw(token: string, amount: bigint, to: string): Promise<Receipt>;
  /**
   * Lock funds in the escrow against a claim commitment, in ONE pool transaction: withdraw to the
   * escrow, then invoke it. Splitting the two would leave a window where the escrow holds funds it
   * has no commitment for — and anyone's next deposit could claim them as its own funding.
   */
  createClaimEscrow(params: ClaimEscrowParams): Promise<Receipt>;
  balances(tokens: string[]): Promise<Record<string, bigint>>;
}

export interface ClaimEscrowParams {
  token: string;
  amount: bigint;
  /** `poseidon(CLAIM_TAG, claimSecret)` — the escrow's storage key. */
  commitmentHash: string;
  /** `poseidon(REFUND_TAG, refundSecret)` — what the payer must prove to take the funds back. */
  refundHash: string;
  /** Blocks from now until the claim window closes and the refund window opens. */
  expiryBlocks: number;
}

/**
 * Discovery and note selection are refreshed on every call rather than cached.
 *
 * The SDK's own guidance is to go stateless: a persisted registry means cursor drift, reorg
 * reconciliation and stale-channel bugs, and it only becomes a bottleneck past several thousand
 * notes. An autonomous payer is exactly the workload where a stale note set silently double-spends.
 */
const REFRESH = { notes: "refresh", channels: "refresh" } as const;

export function createKeseWallet(deps: KeseWalletDeps): KeseWallet {
  const { transfers, address, submitter, redact } = deps;

  /**
   * `provingBlockId = head - 10` — always.
   *
   * Three reasons collapse into one number: notes mature 10 blocks after creation, it buys a reorg
   * buffer, and it pins discovery and proving to the same state. The compiler forwards this to the
   * discovery calls so both see one block.
   */
  async function provingBlockId(): Promise<number> {
    return (await submitter.head()) - 10;
  }

  /** Compile a build, then either simulate it or submit it, and shape the outcome as a Receipt. */
  async function run(build: (provingBlock: number) => Executable): Promise<Receipt> {
    try {
      const provingBlock = await provingBlockId();
      const chain = build(provingBlock);

      if (deps.simulateNode) {
        await chain.simulate({ node: deps.simulateNode, provingBlockId: provingBlock });
        return { status: "simulated" };
      }

      const result = await chain.execute({ provingBlockId: provingBlock });
      const { txHash, blockNumber } = await submitter.submit(result);
      return { status: "confirmed", txHash, blockNumber };
    } catch (error) {
      return { status: "failed", error: redact(error) };
    }
  }

  return {
    async register() {
      return run((provingBlock) => transfers.build({ provingBlockId: provingBlock }).register());
    },

    async shield(token, amount) {
      return run((provingBlock) =>
        transfers
          // autoRegister: registration is an idempotent PREREQUISITE, not a spend — the SDK acts
          // only when the account's on-chain viewing key is actually absent. Without it a first
          // shield fails with "Missing channel context", which reads like a channel bug, and in
          // simulate mode calling register() first cannot help: a simulated registration is never
          // submitted, so the account stays unregistered.
          // autoSetup: a note cannot be created before its token subchannel exists. Without this
          // the mock pool reports the misleading "Token <n> does not exist" — which is a
          // subchannel assertion, not a missing ERC-20 (docs/decisions.md D-009).
          .build({
            autoRegister: true,
            autoSetup: true,
            autoDiscover: REFRESH,
            provingBlockId: provingBlock,
          })
          .with(token, (t) => t.deposit({ amount }))
          .surplusTo(address)
      );
    },

    async payPrivate(token, amount, recipient) {
      return run((provingBlock) =>
        transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            // "naive" selects the minimum set of notes rather than sweeping every note the wallet
            // holds. That keeps unrelated notes unspent and available to fund parallel payments —
            // the whole point of the denomination ladder in notes.ts.
            autoSelectNotes: "naive",
            autoDiscover: REFRESH,
            provingBlockId: provingBlock,
          })
          .with(token, (t) => t.transfer({ recipient, amount }))
          .surplusTo(address)
      );
    },

    async withdraw(token, amount, to) {
      return run((provingBlock) =>
        transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: REFRESH,
            provingBlockId: provingBlock,
          })
          .with(token, (t) => t.withdraw({ recipient: to, amount }))
          // Change stays private with the sender, rather than following the public withdrawal.
          .surplusTo(address)
      );
    },

    async createClaimEscrow(params) {
      if (!deps.escrowAddress) {
        // Fail closed and say which setting is missing, rather than building a transaction that
        // would withdraw funds to nowhere.
        return {
          status: "failed",
          error:
            "no escrow contract configured (ESCROW_CONTRACT_ADDRESS) — claim links are unavailable",
        };
      }
      const escrow = deps.escrowAddress;

      return run((provingBlock) => {
        // Expiry is absolute, and derived from the SAME block the proof is built against, so the
        // window the contract sees matches the one this transaction was reasoned about.
        const expiryBlock = provingBlock + params.expiryBlocks;
        return transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            autoSelectNotes: "naive",
            autoDiscover: REFRESH,
            provingBlockId: provingBlock,
          })
          .with(params.token, (t) =>
            t.withdraw({ recipient: escrow, amount: params.amount })
          )
          // `false` keeps the change as a private note instead of sending it out publicly with the
          // withdrawal — the escrow should receive exactly the locked amount and nothing else.
          .surplusTo(address, false)
          .invoke(() => ({
            contractAddress: escrow,
            calldata: escrowDepositCalldata({
              commitmentHash: params.commitmentHash,
              refundHash: params.refundHash,
              token: params.token,
              amount: params.amount,
              expiryBlock,
            }),
          }));
      });
    },

    async balances(tokens) {
      const { notes } = await transfers.discoverNotes({
        tokens: tokens.map((token) => BigInt(token)),
      });
      const result: Record<string, bigint> = {};
      for (const token of tokens) {
        // Keyed by the address the caller passed, so a lookup with the same string works. Report an
        // explicit zero rather than omitting the key: `balances[token]` should be 0n, not
        // undefined, or "no notes yet" becomes a crash one layer up.
        const held = notes.get(BigInt(token)) ?? [];
        result[token] = held.reduce((sum, note) => sum + note.amount, 0n);
      }
      return result;
    },
  };
}
