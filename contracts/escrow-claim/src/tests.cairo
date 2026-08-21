//! Escrow tests.
//!
//! The escrow holds other people's money and hands it out on proof of a secret, so the cases that
//! matter are the ones where someone gets paid who should not have been: a second claim, a claim
//! after the refund window opened, a refund by a stranger, a deposit backed by funds already
//! promised to someone else. Happy paths are the smaller half of this file on purpose.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_number_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::escrow::{
    CommitmentEntry, EscrowOperation, IEscrowClaimDispatcher, IEscrowClaimDispatcherTrait,
};
use crate::mocks::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

const CLAIM_TAG: felt252 = 'KESE_ESCROW_CLAIM_V1';
const REFUND_TAG: felt252 = 'KESE_ESCROW_REFUND_V1';

const CLAIM_SECRET: felt252 = 'claim-secret-abc';
const REFUND_SECRET: felt252 = 'refund-secret-xyz';
const AMOUNT: u128 = 1000;
const EXPIRY: u64 = 500;
const NOTE: felt252 = 'note-1';

fn pool() -> ContractAddress {
    0x9001.try_into().unwrap()
}

fn stranger() -> ContractAddress {
    0xbad.try_into().unwrap()
}

fn claim_hash(secret: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![CLAIM_TAG, secret].span())
}

fn refund_hash(secret: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![REFUND_TAG, secret].span())
}

/// Escrow + a token it already holds `funded` of, as the pool would have left it.
fn setup(funded: u256) -> (IEscrowClaimDispatcher, IMockERC20Dispatcher) {
    let token_class = declare("MockERC20").unwrap().contract_class();
    let (token_address, _) = token_class.deploy(@array![]).unwrap();
    let token = IMockERC20Dispatcher { contract_address: token_address };

    let escrow_class = declare("EscrowClaim").unwrap().contract_class();
    let (escrow_address, _) = escrow_class.deploy(@array![pool().into()]).unwrap();
    let escrow = IEscrowClaimDispatcher { contract_address: escrow_address };

    // The pool withdraws to the escrow earlier in the same transaction; this is that state.
    token.mint(escrow_address, funded);
    start_cheat_block_number_global(100);
    (escrow, token)
}

fn deposit(escrow: IEscrowClaimDispatcher, token: ContractAddress) {
    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            refund_hash(REFUND_SECRET),
            token,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
    stop_cheat_caller_address(escrow.contract_address);
}

// ---------------------------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------------------------

#[test]
fn deposit_records_the_commitment() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    let entry: CommitmentEntry = escrow.get_commitment(claim_hash(CLAIM_SECRET));
    assert!(entry.amount == AMOUNT, "amount stored");
    assert!(!entry.settled, "not settled yet");
    assert!(entry.expiry_block == EXPIRY, "expiry stored");
    assert!(escrow.total_committed(token.contract_address) == AMOUNT, "obligation tracked");
}

#[test]
fn claim_pays_out_and_approves_the_pool() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    let deposits = escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
    stop_cheat_caller_address(escrow.contract_address);

    assert!(deposits.len() == 1, "one deposit returned");
    let out = *deposits.at(0);
    assert!(out.note_id == NOTE, "credits the claimer's note");
    assert!(out.amount == AMOUNT, "full amount");

    // Approve, don't transfer: the pool pulls the funds itself as it applies the deposit.
    assert!(
        token.allowance(escrow.contract_address, pool()) == AMOUNT.into(), "pool is approved",
    );
    assert!(escrow.total_committed(token.contract_address) == 0, "obligation released");
}

#[test]
fn refund_after_expiry_returns_the_funds() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);
    start_cheat_block_number_global(EXPIRY);

    start_cheat_caller_address(escrow.contract_address, pool());
    let deposits = escrow
        .privacy_invoke(
            EscrowOperation::Refund,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            0,
            REFUND_SECRET,
            NOTE,
            0,
        );
    stop_cheat_caller_address(escrow.contract_address);

    assert!(deposits.len() == 1, "one deposit returned");
    assert!(*deposits.at(0).amount == AMOUNT, "full amount back");
    assert!(escrow.total_committed(token.contract_address) == 0, "obligation released");
}

// ---------------------------------------------------------------------------------------------
// Someone gets paid who should not
// ---------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected: 'ESCROW_CALLER_NOT_POOL')]
fn a_direct_caller_cannot_drive_the_escrow() {
    // Unlike the stateless reference anonymizers, this contract decides who gets paid from stored
    // state — so a caller who bypasses the pool bypasses its accounting too.
    let (escrow, token) = setup(AMOUNT.into());
    start_cheat_caller_address(escrow.contract_address, stranger());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            refund_hash(REFUND_SECRET),
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_ALREADY_SETTLED')]
fn a_link_cannot_be_claimed_twice() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_EXPIRED')]
fn a_claim_stops_working_once_the_refund_window_opens() {
    // Claim and refund must never both be open, or the two could race for the same funds.
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);
    start_cheat_block_number_global(EXPIRY);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_NOT_YET_EXPIRED')]
fn the_payer_cannot_refund_before_expiry() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Refund,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            0,
            REFUND_SECRET,
            NOTE,
            0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_BAD_REFUND_SECRET')]
fn a_stranger_who_reads_the_chain_cannot_refund_someone_elses_escrow() {
    // The commitment hash is public — it is on-chain. Knowing it must not be enough, or every
    // expired escrow would be free money for whoever watches for them.
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);
    start_cheat_block_number_global(EXPIRY);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Refund,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            0,
            'wrong-secret',
            NOTE,
            0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_BAD_REFUND_SECRET')]
fn the_refund_path_hashes_under_its_own_tag() {
    // A real domain-separation test, and it took a mutation to get here. The obvious version —
    // "refund with the claim secret fails" — passes even when both tags are made identical,
    // because the test computes the stored hash with its own constant. It was measuring "a
    // different secret does not work", which the stranger test already covers.
    //
    // This one deposits a refund commitment built with the CLAIM tag. If the contract hashed the
    // refund preimage under the same tag, that would match and the refund would succeed. It must
    // not: the refund path has to hash under REFUND_TAG.
    let (escrow, token) = setup(AMOUNT.into());
    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            claim_hash(REFUND_SECRET), // deliberately the WRONG tag
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
    start_cheat_block_number_global(EXPIRY);
    escrow
        .privacy_invoke(
            EscrowOperation::Refund,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            0,
            REFUND_SECRET,
            NOTE,
            0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_HASHES_EQUAL')]
fn a_deposit_reusing_one_hash_for_both_roles_is_refused() {
    // The degenerate client bug: the same commitment passed for both. The claimer would then hold
    // everything needed to refund as well, so the expiry would protect nobody.
    //
    // Note what this canNOT catch: a payer using the same SECRET for both roles still produces two
    // different hashes, and the recipient who learns that secret can refund with it after expiry.
    // Only independent secrets prevent that, and that is enforced where they are generated.
    let (escrow, token) = setup(AMOUNT.into());
    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            claim_hash(CLAIM_SECRET),
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_UNKNOWN_COMMITMENT')]
fn a_wrong_claim_secret_matches_nothing() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, 'guessed', NOTE, 0,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_ALREADY_SETTLED')]
fn a_refunded_escrow_cannot_then_be_claimed() {
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);
    start_cheat_block_number_global(EXPIRY);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Refund,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            0,
            REFUND_SECRET,
            NOTE,
            0,
        );
    // Back in time is impossible on a real chain, but the settled flag must carry the guarantee
    // rather than the clock.
    start_cheat_block_number_global(100);
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
}

// ---------------------------------------------------------------------------------------------
// Deposits that are not really funded
// ---------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected: 'ESCROW_UNDERFUNDED')]
fn a_deposit_the_pool_never_funded_is_refused() {
    let (escrow, token) = setup(0);
    deposit(escrow, token.contract_address);
}

#[test]
#[should_panic(expected: 'ESCROW_UNDERFUNDED')]
fn a_second_deposit_cannot_reuse_the_first_ones_funds() {
    // The dangerous case: the balance looks sufficient for each deposit taken alone, but the money
    // is already promised. Without tracking obligations, whoever claims last finds nothing left.
    let (escrow, token) = setup(AMOUNT.into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash('second-link'),
            refund_hash('second-refund'),
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_COMMITMENT_EXISTS')]
fn a_commitment_cannot_be_overwritten() {
    let (escrow, token) = setup((AMOUNT * 2).into());
    deposit(escrow, token.contract_address);
    deposit(escrow, token.contract_address);
}

#[test]
#[should_panic(expected: 'ESCROW_ZERO_REFUND_HASH')]
fn a_deposit_with_no_refund_commitment_is_refused() {
    // Without one the funds could never come back, which is the whole reason this contract exists
    // rather than the reference one.
    let (escrow, token) = setup(AMOUNT.into());
    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            0,
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
}

#[test]
#[should_panic(expected: 'ESCROW_EXPIRY_IN_PAST')]
fn a_deposit_that_is_already_expired_is_refused() {
    // It would be refundable immediately and claimable never — a link that cannot work.
    let (escrow, token) = setup(AMOUNT.into());
    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash(CLAIM_SECRET),
            refund_hash(REFUND_SECRET),
            token.contract_address,
            AMOUNT,
            0,
            0,
            50,
        );
}

#[test]
fn two_independent_links_can_coexist() {
    let (escrow, token) = setup((AMOUNT * 2).into());
    deposit(escrow, token.contract_address);

    start_cheat_caller_address(escrow.contract_address, pool());
    escrow
        .privacy_invoke(
            EscrowOperation::Deposit,
            claim_hash('second-link'),
            refund_hash('second-refund'),
            token.contract_address,
            AMOUNT,
            0,
            0,
            EXPIRY,
        );
    assert!(escrow.total_committed(token.contract_address) == AMOUNT * 2, "both tracked");

    // Claiming one must leave the other untouched.
    escrow
        .privacy_invoke(
            EscrowOperation::Claim, 0, 0, token.contract_address, 0, CLAIM_SECRET, NOTE, 0,
        );
    assert!(escrow.total_committed(token.contract_address) == AMOUNT, "the other survives");
    let other: CommitmentEntry = escrow.get_commitment(claim_hash('second-link'));
    assert!(!other.settled, "second link still claimable");
}

// ---------------------------------------------------------------------------------------------
// Cross-language agreement
// ---------------------------------------------------------------------------------------------

#[test]
fn the_commitment_hash_matches_the_one_typescript_computes() {
    // The server builds the commitment; the contract verifies it. If starknet.js and Cairo ever
    // disagree about poseidon over the same two felts, every claim link becomes unclaimable — and
    // the failure would look like "wrong secret", not "wrong hash function".
    //
    // Expected value produced by:
    //   hash.computePoseidonHashOnElements([
    //     shortString.encodeShortString('KESE_ESCROW_CLAIM_V1'),
    //     shortString.encodeShortString('claim-secret-abc'),
    //   ])
    // and pinned in packages/core/src/claimlink.test.ts, which asserts the same constant from the
    // other side. Either language changing its mind breaks one of the two.
    assert!(
        claim_hash(CLAIM_SECRET) == 0x333440d178fae15c855d393fa65d309453dabcb249ead3f1bd14aa343edc53c,
        "poseidon(CLAIM_TAG, 'claim-secret-abc') diverged from starknet.js",
    );
}
