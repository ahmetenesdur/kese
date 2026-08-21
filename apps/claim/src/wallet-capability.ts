/**
 * Whether a wallet can do STRK20, and how to say what went wrong.
 *
 * The version rule lived in two files — the claim page and the diagnostic — which is one copy too
 * many for a rule that decides whether someone is told their wallet cannot be used. If the two
 * drifted, a wallet would be refused on one page and accepted on the other.
 *
 * The rule itself is a version check on the WALLET, not a call to a data method. Asking
 * `wallet_strk20Balances` to find out whether a stranger's wallet supports STRK20 makes it prompt
 * them to share balances the page has no business seeing, to answer a question the version already
 * answers. (The diagnostic page does call it, on a second deliberate click, because there the
 * person owns the wallet and is interrogating it on purpose.)
 */

/** The Wallet API version that introduced the STRK20 methods. */
export const PRIVACY_WALLET_API = { major: 0, minor: 10 } as const;

export function isPrivacyCapable(versions: readonly string[]): boolean {
  return versions.some((version) => {
    const [major, minor] = version.split(".").map(Number);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
    if (major! > PRIVACY_WALLET_API.major) return true;
    return major === PRIVACY_WALLET_API.major && minor! >= PRIVACY_WALLET_API.minor;
  });
}

/**
 * One readable line out of whatever a wallet threw.
 *
 * Wallets reject in every shape there is: an Error, a bare string, an RPC object with a `message`,
 * or something with no useful surface at all. A diagnostic whose output depends on which shape it
 * got is not evidence, so this flattens all of them and never returns an empty string.
 */
export function describeError(error: unknown): string {
  const trim = (value: string): string => value.split("\n")[0]!.trim().slice(0, 200);

  if (error instanceof Error && error.message) return trim(error.message);
  if (typeof error === "string" && error.trim()) return trim(error);

  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return trim(message);
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return trim(json);
    } catch {
      /* circular or otherwise unserialisable */
    }
  }

  return "no reason given";
}
