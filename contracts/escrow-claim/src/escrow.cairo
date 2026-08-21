//! Claim-link escrow with expiry and refund.
//!
//! Lets Kese pay someone who is **not registered** with STRK20. The payer locks funds here through
//! the privacy pool; the recipient claims them later with a secret link. Our extension over the
//! unofficial reference is the second half: if nobody claims, the funds come back.
//!
//! ## Who may refund — the question the reference does not have to answer
//!
//! The reference escrow has no refund at all: an unclaimed payment is locked forever. Adding one
//! raises a problem that has no obvious answer, because **the escrow cannot see who is asking**.
//! Every call arrives from the privacy pool — that is the entire point of the pool — so
//! `get_caller_address()` is always the pool, never the payer. A refund keyed on "the payer asked"
//! is unimplementable, and one keyed on the commitment hash alone would let anyone who reads the
//! chain refund a stranger's escrow into their own note.
//!
//! So the payer holds a secret too. At deposit the payer supplies two commitments: the **claim**
//! commitment, which travels in the link, and a **refund** commitment they keep. Claiming proves
//! the claim preimage; refunding proves the refund preimage. Symmetric, and it needs no identity.
//!
//! The two are domain-separated by different tags, so the claim and refund preimages live in
//! disjoint hash spaces and neither commitment can be mistaken for the other.
//!
//! **What domain separation does not buy** — worth stating, because the first version of this
//! comment claimed more than the code delivers, and a mutation test caught it. If the payer uses
//! the SAME secret for both roles, the recipient who learns it can refund with it after expiry:
//! the tags are public constants, so the recipient can derive the refund commitment too. Different
//! tags make the two hashes differ; they cannot make a reused secret safe. The contract rejects the
//! degenerate case where both commitments are literally equal, but genuinely independent secrets
//! are an invariant of whoever generates them — for Kese, the server, from a CSPRNG.
//!
//! ## Honest limitation
//!
//! The claimed **amount is public**. The pool credits a claimer through an open note, and open
//! notes carry their amount in plaintext. The claimer's identity stays hidden; what they received
//! does not. The claim page has to say so.
//!
//! ## Status
//!
//! Unaudited. Adapted in pattern only from the unofficial reference in the STRK20 docs; the
//! expiry/refund design above is ours and has had no external review.

use starknet::ContractAddress;

/// Mirrors `privacy::objects::OpenNoteDeposit` from the SDK monorepo.
///
/// Declared here rather than imported: the upstream package pins a newer toolchain than this repo
/// uses, and compatibility across the ABI boundary is a matter of serialisation, not of sharing a
/// type. Three flat fields, in this order — if upstream ever changes it, this must change with it.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

/// A locked payment, keyed by its claim commitment.
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct CommitmentEntry {
    pub token: ContractAddress,
    pub amount: u128,
    /// Set by either a claim or a refund. One entry, one payout, whichever way it goes.
    pub settled: bool,
    /// Block from which a refund becomes possible and a claim stops being possible.
    pub expiry_block: u64,
    /// `poseidon(REFUND_TAG, refund_secret)` — what the payer must prove to take the funds back.
    pub refund_hash: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum EscrowOperation {
    /// Lock funds the pool has just withdrawn to this contract.
    Deposit,
    /// Recipient proves the claim secret before expiry.
    Claim,
    /// Payer proves the refund secret at or after expiry.
    Refund,
}

#[starknet::interface]
pub trait IEscrowClaim<T> {
    /// Read a commitment. Public by nature — the entry is on-chain anyway.
    fn get_commitment(self: @T, commitment_hash: felt252) -> CommitmentEntry;

    /// Total still owed for a token. Deposits are refused if the balance cannot cover it.
    fn total_committed(self: @T, token: ContractAddress) -> u128;

    fn pool(self: @T) -> ContractAddress;

    /// The single entry point the privacy pool invokes. See the module docs for the design.
    ///
    /// `secret` carries the claim preimage on `Claim` and the refund preimage on `Refund`; it is
    /// unused on `Deposit`. `commitment_hash` is the storage key throughout — on `Claim` it is
    /// recomputed from the preimage and the supplied value is not trusted.
    fn privacy_invoke(
        ref self: T,
        operation: EscrowOperation,
        commitment_hash: felt252,
        refund_hash: felt252,
        token: ContractAddress,
        amount: u128,
        secret: felt252,
        note_id: felt252,
        expiry_block: u64,
    ) -> Span<OpenNoteDeposit>;
}

/// Minimal ERC20 surface. Only what the escrow uses — see the Scarb.toml note on not pulling
/// OpenZeppelin in for three methods.
#[starknet::interface]
pub trait IERC20<T> {
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @T, account: ContractAddress) -> u256;
}

pub mod errors {
    pub const NOT_POOL: felt252 = 'ESCROW_CALLER_NOT_POOL';
    pub const ZERO_TOKEN: felt252 = 'ESCROW_ZERO_TOKEN';
    pub const ZERO_AMOUNT: felt252 = 'ESCROW_ZERO_AMOUNT';
    pub const ZERO_COMMITMENT: felt252 = 'ESCROW_ZERO_COMMITMENT';
    pub const ZERO_REFUND_HASH: felt252 = 'ESCROW_ZERO_REFUND_HASH';
    pub const HASHES_EQUAL: felt252 = 'ESCROW_HASHES_EQUAL';
    pub const COMMITMENT_EXISTS: felt252 = 'ESCROW_COMMITMENT_EXISTS';
    pub const UNDERFUNDED: felt252 = 'ESCROW_UNDERFUNDED';
    pub const EXPIRY_IN_PAST: felt252 = 'ESCROW_EXPIRY_IN_PAST';
    pub const UNKNOWN_COMMITMENT: felt252 = 'ESCROW_UNKNOWN_COMMITMENT';
    pub const ALREADY_SETTLED: felt252 = 'ESCROW_ALREADY_SETTLED';
    pub const EXPIRED: felt252 = 'ESCROW_EXPIRED';
    pub const NOT_YET_EXPIRED: felt252 = 'ESCROW_NOT_YET_EXPIRED';
    pub const BAD_REFUND_SECRET: felt252 = 'ESCROW_BAD_REFUND_SECRET';
}

#[starknet::contract]
pub mod EscrowClaim {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_block_number, get_caller_address, get_contract_address};
    use super::{
        CommitmentEntry, EscrowOperation, IERC20Dispatcher, IERC20DispatcherTrait, IEscrowClaim,
        OpenNoteDeposit, errors,
    };

    /// Domain separation. A claim secret hashed under the claim tag can never collide with the same
    /// value hashed under the refund tag, so one preimage cannot serve both roles.
    const CLAIM_TAG: felt252 = 'KESE_ESCROW_CLAIM_V1';
    const REFUND_TAG: felt252 = 'KESE_ESCROW_REFUND_V1';

    #[storage]
    struct Storage {
        /// Only this address may invoke. Nobody drives the escrow directly.
        pool: ContractAddress,
        commitments: Map<felt252, CommitmentEntry>,
        /// Outstanding obligations per token, so a deposit cannot be recorded against funds that
        /// are already promised to someone else.
        committed: Map<ContractAddress, u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        EscrowCreated: EscrowCreated,
        EscrowClaimed: EscrowClaimed,
        EscrowRefunded: EscrowRefunded,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EscrowCreated {
        #[key]
        pub commitment_hash: felt252,
        #[key]
        pub token: ContractAddress,
        pub amount: u128,
        pub expiry_block: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EscrowClaimed {
        #[key]
        pub commitment_hash: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EscrowRefunded {
        #[key]
        pub commitment_hash: felt252,
        pub amount: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress) {
        assert(pool.is_non_zero(), errors::NOT_POOL);
        self.pool.write(pool);
    }

    #[abi(embed_v0)]
    pub impl EscrowClaimImpl of IEscrowClaim<ContractState> {
        fn get_commitment(self: @ContractState, commitment_hash: felt252) -> CommitmentEntry {
            self.commitments.read(commitment_hash)
        }

        fn total_committed(self: @ContractState, token: ContractAddress) -> u128 {
            self.committed.read(token)
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }

        fn privacy_invoke(
            ref self: ContractState,
            operation: EscrowOperation,
            commitment_hash: felt252,
            refund_hash: felt252,
            token: ContractAddress,
            amount: u128,
            secret: felt252,
            note_id: felt252,
            expiry_block: u64,
        ) -> Span<OpenNoteDeposit> {
            // The escrow holds other people's money and decides who gets it from stored state. A
            // direct caller could claim or refund any entry whose preimage they hold, bypassing the
            // pool's accounting entirely — so unlike the stateless reference anonymizers, this one
            // must know who is calling.
            assert(get_caller_address() == self.pool.read(), errors::NOT_POOL);

            match operation {
                EscrowOperation::Deposit => self
                    .do_deposit(commitment_hash, refund_hash, token, amount, expiry_block),
                EscrowOperation::Claim => self.do_claim(secret, note_id),
                EscrowOperation::Refund => self.do_refund(commitment_hash, secret, note_id),
            }
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn do_deposit(
            ref self: ContractState,
            commitment_hash: felt252,
            refund_hash: felt252,
            token: ContractAddress,
            amount: u128,
            expiry_block: u64,
        ) -> Span<OpenNoteDeposit> {
            assert(commitment_hash.is_non_zero(), errors::ZERO_COMMITMENT);
            // Without a refund commitment the funds could never come back — which is the whole
            // reason this contract exists rather than the reference one.
            assert(refund_hash.is_non_zero(), errors::ZERO_REFUND_HASH);
            // The degenerate client bug: the same commitment passed for both roles. The claimer
            // would then hold everything needed to refund as well, so the expiry would protect
            // nobody. Cheap to reject, and impossible to notice later.
            assert(refund_hash != commitment_hash, errors::HASHES_EQUAL);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(expiry_block > get_block_number(), errors::EXPIRY_IN_PAST);

            let existing = self.commitments.read(commitment_hash);
            // Reusing a commitment would overwrite a live entry and strand its funds. The secret is
            // generated with a CSPRNG, so this only fires on a bug or a replay.
            assert(existing.amount.is_zero(), errors::COMMITMENT_EXISTS);

            // The pool withdrew the funds to this contract earlier in the same transaction. Verify
            // they actually arrived AND that they are not money already promised to another
            // commitment — otherwise one claimant could be paid out of another's escrow, and the
            // shortfall would only surface for whoever claimed last.
            let outstanding = self.committed.read(token);
            let balance = IERC20Dispatcher { contract_address: token }
                .balance_of(get_contract_address());
            let required: u256 = (outstanding + amount).into();
            assert(balance >= required, errors::UNDERFUNDED);

            self
                .commitments
                .write(
                    commitment_hash,
                    CommitmentEntry {
                        token, amount, settled: false, expiry_block, refund_hash,
                    },
                );
            self.committed.write(token, outstanding + amount);

            self.emit(EscrowCreated { commitment_hash, token, amount, expiry_block });

            // Nothing to credit: the payer is giving money up, not receiving any.
            array![].span()
        }

        fn do_claim(
            ref self: ContractState, secret: felt252, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // The preimage IS the key. Any `commitment_hash` the caller passed is ignored here —
            // trusting it would let someone name one entry while proving the secret of another.
            let commitment_hash = poseidon_hash_span(array![CLAIM_TAG, secret].span());
            let entry = self.commitments.read(commitment_hash);

            assert(entry.amount.is_non_zero(), errors::UNKNOWN_COMMITMENT);
            assert(!entry.settled, errors::ALREADY_SETTLED);
            // Strictly before expiry: at the expiry block the refund window opens, and the two must
            // never both be open or claim and refund could race for the same funds.
            assert(get_block_number() < entry.expiry_block, errors::EXPIRED);

            self.settle(commitment_hash, entry);
            self.emit(EscrowClaimed { commitment_hash, amount: entry.amount });
            self.payout(entry, note_id)
        }

        fn do_refund(
            ref self: ContractState, commitment_hash: felt252, secret: felt252, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // Refund needs the hash as a lookup key, because the refund preimage hashes to a
            // different value than the storage key. The key is public; the secret is what
            // authorises, so naming an entry you cannot open gets you nothing.
            let entry = self.commitments.read(commitment_hash);

            assert(entry.amount.is_non_zero(), errors::UNKNOWN_COMMITMENT);
            assert(!entry.settled, errors::ALREADY_SETTLED);
            assert(get_block_number() >= entry.expiry_block, errors::NOT_YET_EXPIRED);

            let offered = poseidon_hash_span(array![REFUND_TAG, secret].span());
            assert(offered == entry.refund_hash, errors::BAD_REFUND_SECRET);

            self.settle(commitment_hash, entry);
            self.emit(EscrowRefunded { commitment_hash, amount: entry.amount });
            self.payout(entry, note_id)
        }

        /// Mark settled and release the obligation. Done BEFORE any external call.
        fn settle(ref self: ContractState, commitment_hash: felt252, entry: CommitmentEntry) {
            self
                .commitments
                .write(commitment_hash, CommitmentEntry { settled: true, ..entry });
            self.committed.write(entry.token, self.committed.read(entry.token) - entry.amount);
        }

        /// Approve the pool to pull the funds and tell it which note to credit.
        ///
        /// Approve rather than transfer: the pool moves the money itself as part of applying the
        /// returned deposits, and measures what it received. Sending directly would leave its
        /// accounting and the token balance disagreeing.
        fn payout(
            ref self: ContractState, entry: CommitmentEntry, note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            IERC20Dispatcher { contract_address: entry.token }
                .approve(self.pool.read(), entry.amount.into());
            array![OpenNoteDeposit { note_id, token: entry.token, amount: entry.amount }].span()
        }
    }
}
