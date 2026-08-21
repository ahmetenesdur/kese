/**
 * Proof-provider decoration.
 *
 * Proving time is otherwise invisible: it happens inside `execute()`, alongside discovery, note
 * selection and calldata assembly, and those are fast enough that a slow prover looks like a slow
 * transaction. Since proving is the one part of the pipeline we do not control, measuring it
 * separately is what will tell us whether an autonomous payer is viable at all.
 */

import type {
  Proof,
  ProofInvocation,
  ProofProviderInterface,
  ProvingBlockId,
} from "@starkware-libs/starknet-privacy-sdk";

/** Wraps any proof provider and reports how long each `prove()` call took. */
export class TimedProofProvider implements ProofProviderInterface {
  readonly timings: number[] = [];

  constructor(
    private readonly inner: ProofProviderInterface,
    private readonly onProve?: (ms: number) => void
  ) {}

  getDefaultDetails() {
    return this.inner.getDefaultDetails();
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const started = performance.now();
    try {
      return await this.inner.prove(invocation, blockIdentifier);
    } finally {
      // `finally`, so a failed proof is still timed — how long a prover takes to fail is exactly
      // what you want to know when diagnosing a timeout.
      const elapsed = performance.now() - started;
      this.timings.push(elapsed);
      this.onProve?.(elapsed);
    }
  }

  invalidateNonceCache(): void {
    this.inner.invalidateNonceCache?.();
  }

  /** ms spent on the most recent proof, or undefined if none has run. */
  lastTiming(): number | undefined {
    return this.timings.at(-1);
  }
}
