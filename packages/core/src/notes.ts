/**
 * Note denomination ladder — Kese's novel bit (see CLAUDE.md).
 * Problem: change notes mature after 10 blocks; an agent paying in bursts would stall.
 * Strategy: keep balance split into round denominations (e.g. [1,2,5,10,25,50]*10^decimals),
 * top up the ladder opportunistically after each payment, select mature notes greedily.
 * Round denominations also reduce amount-fingerprinting (privacy note in docs §8).
 * TODO(claude-code): planLadder(balance, denoms), selectNotes(amount, matureNotes), rebalanceAfter(payment).
 */
export const DEFAULT_DENOMS = [1n, 2n, 5n, 10n, 25n, 50n];
