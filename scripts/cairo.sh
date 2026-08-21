#!/usr/bin/env bash
#
# Run the Cairo toolchain (scarb / snforge), wherever it happens to live.
#
# Two things make this harder than a PATH lookup, and both bit us:
#
#   1. `command -v scarb` can succeed while `scarb` still fails. asdf installs a *shim* —
#      a stub that re-execs the real binary through `asdf` itself. In a non-interactive
#      shell asdf is usually not on PATH, so the shim resolves, looks executable, and
#      exits with "asdf: not found". Existence is not the test; running it is. So we
#      probe each candidate with `--version` and take the first that actually answers.
#
#   2. PATH routinely contains directories with spaces (on macOS, "Application Support").
#      The previous version of this lived inline in package.json as
#      `bash -c "export PATH=$HOME/...:$PATH && ..."`, where the OUTER shell expanded
#      $PATH into the string before bash parsed it — so the first space ended the
#      assignment and the rest became a stray command. Quoting here is load-bearing.
#
# Usage: bash scripts/cairo.sh {build|test} [extra args...]

set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../contracts/escrow-claim" && pwd)"

# Find a working `$1`, looking under the asdf package named `$2` if PATH does not deliver.
resolve() {
  local tool="$1" asdf_package="$2" candidate

  # Whatever already works on PATH wins: starkup, Homebrew, Nix, or a properly
  # initialised asdf all land here and need no special-casing.
  if command -v "$tool" >/dev/null 2>&1 && "$tool" --version >/dev/null 2>&1; then
    printf '%s' "$tool"
    return 0
  fi

  # Walk asdf installs newest-last-first. A glob (not `ls`) because these are paths, and
  # $(ls) would word-split any of them containing a space — the exact bug noted above.
  # Bash expands the glob in ascending order, so iterating backwards prefers a higher
  # version. That ordering is lexicographic, not semver: it is a tie-break between
  # installs, never a version policy. The contract pins its own versions in Scarb.toml.
  local dirs=("$HOME/.asdf/installs/$asdf_package"/*/bin)
  local i
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    candidate="${dirs[i]}/$tool"
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

missing() {
  cat >&2 <<MSG
Cairo toolchain not found: $1

Install it with starkup (https://github.com/software-mansion/starkup):
  curl --proto '=https' --tlsv1.2 -sSf https://sh.starkup.dev | sh

The escrow contract needs scarb 2.16.0 and starknet-foundry 0.57.0. Everything else in
this repo — the MCP server, the policy engine, all 317 TypeScript tests — builds without
them; only \`pnpm escrow:*\` does.
MSG
  exit 127
}

case "${1:-}" in
  build)
    SCARB="$(resolve scarb scarb)" || missing scarb
    shift
    cd "$CONTRACT_DIR" && exec "$SCARB" build "$@"
    ;;
  test)
    SNFORGE="$(resolve snforge starknet-foundry)" || missing snforge
    # snforge shells out to scarb, so scarb has to be on PATH for the child process even
    # though we never call it directly here.
    if SCARB="$(resolve scarb scarb)"; then
      PATH="$(dirname "$SCARB"):$PATH"
      export PATH
    fi
    shift
    cd "$CONTRACT_DIR" && exec "$SNFORGE" test "$@"
    ;;
  *)
    echo "usage: bash scripts/cairo.sh {build|test} [args...]" >&2
    exit 2
    ;;
esac
