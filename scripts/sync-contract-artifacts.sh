#!/usr/bin/env bash
# Vendors the contract artefacts the backend depends on (pricing vectors, errors, events).
# Usage: scripts/sync-contract-artifacts.sh [path-to-contracts-repo | git-ref]
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-../sorobanpool-contracts}"
mkdir -p test/fixtures src/chain/artifacts
if [ -d "$SRC" ]; then
  cp "$SRC/vectors/pricing-vectors.json" test/fixtures/pricing-vectors.json
  cp "$SRC/artifacts/errors.json" src/chain/artifacts/errors.json
  cp "$SRC/artifacts/events.json" src/chain/artifacts/events.json
else
  base="https://raw.githubusercontent.com/SorobanPool/sorobanpool-contracts/$SRC"
  curl -fsSL "$base/vectors/pricing-vectors.json" -o test/fixtures/pricing-vectors.json
  curl -fsSL "$base/artifacts/errors.json" -o src/chain/artifacts/errors.json
  curl -fsSL "$base/artifacts/events.json" -o src/chain/artifacts/events.json
fi
echo "synced from $SRC"
