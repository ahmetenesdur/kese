# escrow-claim — claim-link payments with expiry+refund

Basis: the unofficial escrow reference in STRK20 docs (`helpers/escrow.md`) — pattern-only, unaudited; we own the review.

## Spec (our extension over the reference)
- `CommitmentEntry { token, amount, claimed, payer_note_hint, expiry_block }`  ← adds expiry + payer info
- `EscrowOperation { Deposit, Claim, Refund }`                                 ← adds Refund
- Deposit: pool withdraws to escrow; store entry keyed by `poseidon(ESCROW_COMMITMENT_TAG, secret)`; record `expiry_block`
- Claim (before expiry): verify preimage; flip `claimed` once (ALREADY_CLAIMED guard); approve pool; return `Span<OpenNoteDeposit>` crediting claimer note
- Refund (after expiry, unclaimed): credit PAYER's note the same way; flip claimed
- Invariants: only pool may call `privacy_invoke`; approve-don't-transfer; exactly one op per pool tx; commitment_hash param ignored on claim (preimage is truth)

## Build/test
`scarb build` · `snforge test` — tests to write: deposit/claim happy path, double-claim, claim-after-expiry fails, refund-before-expiry fails, refund happy path, non-pool caller reverts.
