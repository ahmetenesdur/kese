// Kese escrow-claim: privacy_invoke helper with claim links + expiry/refund.
// STATUS: skeleton. Adapt from the reference in docs (helpers/escrow.md). Unaudited — review required.

#[derive(Serde, Copy, Drop, PartialEq, starknet::Store)]
pub struct CommitmentEntry {
    pub token: starknet::ContractAddress,
    pub amount: u128,
    pub claimed: bool,
    pub expiry_block: u64, // Kese extension
}

#[derive(Serde, Copy, Drop, PartialEq)]
pub enum EscrowOperation {
    Deposit,
    Claim,
    Refund, // Kese extension
}

// TODO(claude-code):
// - OpenNoteDeposit struct per docs (note_id: felt252, token: ContractAddress, amount: u128)
// - storage: privacy_contract address, commitments map
// - constructor(privacy_contract)
// - privacy_invoke(operation, commitment_hash, token, amount, secret, note_id, expiry_block) -> Span<OpenNoteDeposit>
//   * assert caller == privacy_contract
//   * Deposit: store entry (unclaimed, expiry); funds already pulled by pool flow
//   * Claim: hash = poseidon(ESCROW_COMMITMENT_TAG, secret); entry = read(hash); assert !claimed && block < expiry;
//            mark claimed; approve pool; return [OpenNoteDeposit{note_id, token, amount}]
//   * Refund: assert !claimed && block >= expiry; mark claimed; credit payer note
// - events: EscrowCreated(hash, token, amount, expiry), EscrowClaimed(hash), EscrowRefunded(hash)
