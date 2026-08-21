# escrow-claim — claim-link payments with expiry and refund

Lets Kese pay someone who is **not registered** with STRK20. The payer locks funds here through the
privacy pool; the recipient claims them with a secret link. Our contribution over the unofficial
reference is the second half: if nobody claims, the funds come back.

Basis: the unofficial escrow reference in the STRK20 docs — pattern only, unaudited. **We own the
review.** The expiry/refund design below is ours and has had no external review.

## The question the reference does not have to answer

The reference has no refund at all: an unclaimed payment is locked forever. Adding one raises a
problem with no obvious answer, because **the escrow cannot see who is asking**. Every call arrives
from the privacy pool — that is the entire point of the pool — so `get_caller_address()` is always
the pool, never the payer. A refund keyed on "the payer asked" is unimplementable, and one keyed on
the commitment hash alone would let anyone who reads the chain refund a stranger's escrow into their
own note.

**So the payer holds a secret too.** At deposit the payer supplies two commitments: the *claim*
commitment, which travels in the link, and a *refund* commitment they keep. Claiming proves the
claim preimage; refunding proves the refund preimage. Symmetric, and it needs no identity.

## Interface

```cairo
CommitmentEntry { token, amount, settled, expiry_block, refund_hash }
EscrowOperation { Deposit, Claim, Refund }

fn privacy_invoke(
    operation, commitment_hash, refund_hash, token, amount, secret, note_id, expiry_block
) -> Span<OpenNoteDeposit>
```

- **Deposit** — pool has already withdrawn to the escrow; store the entry keyed by
  `poseidon(CLAIM_TAG, claim_secret)`, record `expiry_block` and `refund_hash`. Returns an empty
  span: the payer is giving money up, not receiving any.
- **Claim** (strictly before expiry) — the preimage IS the key; any `commitment_hash` passed in is
  ignored. Settle once, approve the pool, return one `OpenNoteDeposit`.
- **Refund** (at or after expiry) — look up by `commitment_hash` (public, just a key), authorise
  with the refund preimage.

Invariants: only the pool may invoke · approve-don't-transfer · claim and refund windows never
overlap · one settlement per entry, whichever way it goes · a deposit must be backed by funds not
already promised to another commitment.

## What is protected, and what is not

Domain-separated tags put the claim and refund preimages in disjoint hash spaces. They do **not**
make a reused secret safe: the tags are public constants, so a payer who uses one secret for both
roles lets the recipient derive the refund commitment too. The contract rejects the degenerate case
where both commitments are literally equal; genuinely independent secrets are an invariant of
whoever generates them — for Kese, the server, from a CSPRNG.

**The claimed amount is public.** The pool credits a claimer through an open note, and open notes
carry their amount in plaintext. The claimer's identity stays hidden; what they received does not.
The claim page has to say so.

## Build and test

The toolchain lives under asdf, whose shims are currently broken on this machine — call the binaries
directly:

```sh
export PATH="$HOME/.asdf/installs/scarb/2.16.0/bin:$HOME/.asdf/installs/starknet-foundry/0.57.0/bin:$PATH"
scarb build && snforge test
```

18 tests. The security-critical ones were **mutation-verified**: each guarantee was deliberately
broken in the contract to confirm a test goes red. That caught a test which passed for the wrong
reason — see `docs/decisions.md` D-028.
