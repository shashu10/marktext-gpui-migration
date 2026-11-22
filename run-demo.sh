#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

echo "======================================================================"
echo " MarkText -> MarkText-GPUI Strangler-Fig Migration Demo (AI SDLC)"
echo "======================================================================"
echo ""

if ! command -v cargo >/dev/null 2>&1; then
  echo "[error] Rust toolchain (cargo) not found on PATH." >&2
  echo "        Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[error] pnpm not found on PATH. Install via: corepack enable && corepack prepare pnpm@10 --activate" >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/tools/migration-sdk/node_modules" ]; then
  echo "[setup] Installing tools/migration-sdk dependencies..."
  pnpm --dir "$ROOT_DIR/tools/migration-sdk" install --frozen-lockfile || pnpm --dir "$ROOT_DIR/tools/migration-sdk" install
fi

if [ ! -x "$ROOT_DIR/rust/target/release/marktext-core-cli" ]; then
  echo "[setup] Building Rust marktext-core-cli (release)..."
  cargo build --release --manifest-path "$ROOT_DIR/rust/Cargo.toml" -p marktext-core
fi

echo "[run] Executing end-to-end mid-migration verification & Before/After Scorecard..."
echo ""
exec pnpm --dir "$ROOT_DIR/tools/migration-sdk" demo "$@"
