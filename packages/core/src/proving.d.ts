/**
 * Proof-provider decoration.
 *
 * Proving time is otherwise invisible: it happens inside `execute()`, alongside discovery, note
 * selection and calldata assembly, and those are fast enough that a slow prover looks like a slow
 * transaction. Since proving is the one part of the pipeline we do not control, measuring it
 * separately is what will tell us whether an autonomous payer is viable at all.
 */
import type { Proof, ProofInvocation, ProofProviderInterface, ProvingBlockId } from "@starkware-libs/starknet-privacy-sdk";
/** Wraps any proof provider and reports how long each `prove()` call took. */
export declare class TimedProofProvider implements ProofProviderInterface {
    private readonly inner;
    private readonly onProve?;
    readonly timings: number[];
    constructor(inner: ProofProviderInterface, onProve?: ((ms: number) => void) | undefined);
    getDefaultDetails(): Promise<import("@starkware-libs/starknet-privacy-sdk").ProofInvocationFactoryDetails>;
    prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof>;
    invalidateNonceCache(): void;
    /** ms spent on the most recent proof, or undefined if none has run. */
    lastTiming(): number | undefined;
}
