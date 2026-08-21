#!/usr/bin/env bash
#
# Stand up a self-hosted STRK20 transaction prover.
#
# This is Gate G1's first fallback (docs/decisions.md D-037): if the hosted proving service stays
# unavailable, running our own keeps the agent autonomous, which is the entire premise of Kese. The
# alternative — the Wallet API route, where a human taps every payment — gives that up.
#
# RUN THIS ON A RENTED amd64 LINUX BOX, not on a laptop. Two reasons, both established:
#
#   * The published arm64 image dies with SIGILL on Apple Silicon. The binary really is aarch64,
#     but it uses instructions this CPU does not implement — `--version` exits 132 with no output.
#   * The prover's own README asks for a c4d-highcpu-48 or equivalent: 48 vCPU, 96 GB RAM, amd64.
#     Proving time is "highly sensitive to the machine type", so a smaller box is a gamble you
#     measure rather than assume — which is what --benchmark below is for.
#
# What it does NOT need: a Pathfinder node. The compatibility matrix lists one alongside the prover,
# which reads like a requirement; the prover's README says it "can point to any Starknet RPC
# endpoint", the only constraint being v0.10 API support. That is a much lower bar — no full node
# to sync. This script verifies the endpoint before starting anything, because discovering it at
# proof time costs an hour.
#
# Usage:
#   ./scripts/prover-up.sh --network sepolia --rpc-url https://…/rpc/v0_10/KEY
#   ./scripts/prover-up.sh --network mainnet --rpc-url … --concurrency 4
#   ./scripts/prover-up.sh --stop

set -euo pipefail

IMAGE="ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2"
NAME="kese-prover"
PORT=3000
NETWORK=""
RPC_URL=""
CONCURRENCY=2

die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --network)     NETWORK="${2:-}"; shift 2 ;;
    --rpc-url)     RPC_URL="${2:-}"; shift 2 ;;
    --port)        PORT="${2:-}"; shift 2 ;;
    --concurrency) CONCURRENCY="${2:-}"; shift 2 ;;
    --stop)
      # `docker rm -f` exits 0 for a container that does not exist, so its exit code cannot tell
      # us whether anything was actually stopped. Ask first, rather than report a stop that never
      # happened.
      if [ -n "$(docker ps -aq --filter "name=^${NAME}$" 2>/dev/null)" ]; then
        docker rm -f "$NAME" >/dev/null && echo "stopped $NAME"
      else
        echo "$NAME is not running"
      fi
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$NETWORK" ] || die "--network sepolia|mainnet is required"
[ -n "$RPC_URL" ] || die "--rpc-url is required"

case "$NETWORK" in
  sepolia) CHAIN_ID="SN_SEPOLIA" ;;
  mainnet) CHAIN_ID="SN_MAIN" ;;
  *) die "--network must be sepolia or mainnet" ;;
esac

# CHAIN_ID defaults to SN_MAIN inside the image. Left unset on a Sepolia box the prover would load
# mainnet fee-token addresses and versioned constants and fail in a way that looks like a bad
# transaction, so it is always passed explicitly — never defaulted.

echo "── preflight ──────────────────────────────────────────────"

command -v docker >/dev/null || die "docker is not installed"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) echo "  ✅ architecture            $ARCH" ;;
  arm64|aarch64)
    die "architecture is $ARCH. The published arm64 image SIGILLs on Apple Silicon (D-037) and the
       prover targets amd64 anyway. Rent an amd64 Linux instance."
    ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')"
echo "  ·  vCPU                    $CPUS  (README recommends 48)"
if [ "$CPUS" != "?" ] && [ "$CPUS" -lt 16 ]; then
  echo "     ⚠️  well under the recommendation. Proving may take minutes or fail on memory."
fi

# The one hard requirement on the RPC endpoint, checked before anything is started: v0.10 support.
echo -n "  ·  RPC spec version        "
SPEC="$(curl -s --max-time 20 -X POST "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",""))' 2>/dev/null || true)"
[ -n "$SPEC" ] || die "the RPC endpoint did not answer starknet_specVersion. Check the URL."
echo "$SPEC"
case "$SPEC" in
  0.10*|0.1[1-9]*) echo "  ✅ RPC supports v0.10" ;;
  *) die "the prover requires a v0.10 RPC endpoint; this one reports $SPEC.
       Alchemy URLs need the /rpc/v0_10/ path segment." ;;
esac

echo
echo "── starting ───────────────────────────────────────────────"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:$PORT:3000" \
  -e RPC_URL="$RPC_URL" \
  -e CHAIN_ID="$CHAIN_ID" \
  -e MAX_CONCURRENT_REQUESTS="$CONCURRENCY" \
  -e PREFETCH_STATE=true \
  "$IMAGE" >/dev/null

# Bound to 127.0.0.1 deliberately. The prover has no authentication of its own, and an open proving
# endpoint is free compute for anyone who finds it. Reach it from elsewhere over an SSH tunnel:
#   ssh -N -L 3000:127.0.0.1:3000 user@box

echo -n "  waiting for the service"
for _ in $(seq 1 60); do
  READY="$(curl -s --max-time 5 -X POST "http://127.0.0.1:$PORT" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",""))' 2>/dev/null || true)"
  if [ -n "$READY" ]; then
    echo
    echo "  ✅ prover answering        spec $READY on port $PORT"
    echo
    echo "── add to .env ────────────────────────────────────────────"
    echo "PROVING_SERVICE_URL_$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')=http://127.0.0.1:$PORT"
    echo
    echo "then:  pnpm smoke:sepolia          # the full flow, real proofs, real transactions"
    echo "logs:  docker logs -f $NAME"
    echo "stop:  ./scripts/prover-up.sh --stop"
    exit 0
  fi
  printf '.'
  sleep 2
done

echo
echo "the service did not answer within two minutes. Last 40 log lines:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
