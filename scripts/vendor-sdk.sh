#!/usr/bin/env bash
#
# Rebuild the vendored Privacy SDK tarball (docs/decisions.md D-005).
#
# WHY THIS EXISTS: the SDK is published to GitHub Packages, which requires the `read:packages`
# scope. If `pnpm install` fails with `403 permission_denied`, the correct fix is:
#
#     gh auth refresh -h github.com -s read:packages
#     npm config set @starkware-libs:registry https://npm.pkg.github.com
#     npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
#
# ...and then to point package.json at a registry version instead of the tarball. This script is
# the fallback for when that scope is not available: the SDK monorepo is public (Apache 2.0), so
# we build the very same artefact from source and pack it locally. No --force, no skipped
# integrity checks — this is the SDK's own `npm run build` output.
#
# Usage: ./scripts/vendor-sdk.sh
set -euo pipefail

# Pin the exact commit the Day-1 spike was verified against. Bump deliberately, not by drift.
SDK_COMMIT="36eac4ea88cd8c59dde1493176e16501c6e90328"
SDK_VERSION="0.14.3-rc.5"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "→ cloning starkware-libs/starknet-privacy @ ${SDK_COMMIT:0:7}"
git clone --quiet --filter=blob:none https://github.com/starkware-libs/starknet-privacy.git "${WORK_DIR}/sdk-repo"
git -C "${WORK_DIR}/sdk-repo" checkout --quiet "${SDK_COMMIT}"

echo "→ building sdk/ (npm ci --ignore-scripts, then tsc)"
cd "${WORK_DIR}/sdk-repo/sdk"
# --ignore-scripts: the SDK depends on starknet-devnet, whose postinstall downloads a binary we
# never use here. Skipping it keeps the build hermetic and fast.
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm run build >/dev/null

mkdir -p "${VENDOR_DIR}"
npm pack --pack-destination "${VENDOR_DIR}" >/dev/null

TARBALL="${VENDOR_DIR}/starkware-libs-starknet-privacy-sdk-${SDK_VERSION}.tgz"
if [[ ! -f "${TARBALL}" ]]; then
  echo "✗ expected ${TARBALL}; the SDK version in package.json may have moved." >&2
  echo "  Packed instead:" >&2
  ls -1 "${VENDOR_DIR}" >&2
  exit 1
fi

echo "✓ ${TARBALL}"
echo "  now run: pnpm install"
