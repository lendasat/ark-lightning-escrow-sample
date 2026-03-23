#!/usr/bin/env bash
# E2E test: exercises TS client → Ruby/Magnus server → Rust escrow → Arkade
#
# Prerequisites: nigiri + arkd + fulmine running
# Usage: just e2e   (or: ./e2e/run.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
logok(){ printf '\033[1;32m ✓\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m  %s\n' "$*" >&2; exit 1; }

cleanup() {
    if [ -n "${SERVER_PID:-}" ]; then
        log "Stopping Ruby server (pid $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# --- Prerequisites ---

curl -sf http://localhost:7070/v1/info >/dev/null 2>&1 || die "arkd not running on :7070"
curl -sf http://localhost:7001/api/v1/wallet/status >/dev/null 2>&1 || die "fulmine not running on :7001"

# --- Fixed keys for the test ---

# Arbiter — deterministic key for the test
ARBITER_SK="0000000000000000000000000000000000000000000000000000000000000001"

# Bob — deterministic key for the test
BOB_SK="0000000000000000000000000000000000000000000000000000000000000002"

# --- Build ---

log "Building Rust native extension..."
cargo build -p ark-escrow-ruby 2>&1 | tail -1
cd target/debug && ln -sf libark_escrow_ruby.so ark_escrow_ruby.so && cd "$ROOT"
logok "Native extension built"

# --- Install deps ---

log "Installing Ruby gems..."
cd sample/server && bundle install --quiet 2>/dev/null && cd "$ROOT"
logok "Ruby gems installed"

log "Installing TS dependencies..."
cd e2e && pnpm install --silent 2>/dev/null && cd "$ROOT"
logok "TS dependencies installed"

# --- Start Ruby server ---

log "Starting Arbiter server..."
cd sample/server
ARBITER_SK="$ARBITER_SK" \
  UNILATERAL_EXIT_DELAY=512 \
  FEE_RATE=0 \
  bundle exec ruby arbiter.rb -o 127.0.0.1 -p 4567 >"$ROOT/e2e/server.log" 2>&1 &
SERVER_PID=$!
cd "$ROOT"

# Wait for server to be ready (404 is fine — it means the server is up)
for i in $(seq 1 30); do
    HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' http://localhost:4567/trades/nonexistent 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" != "000" ]; then
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "--- Server log ---"
        cat e2e/server.log
        die "Ruby server exited early"
    fi
    sleep 0.5
done
HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' http://localhost:4567/trades/nonexistent 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "000" ]; then
    echo "--- Server log ---"
    cat e2e/server.log
    die "Ruby server didn't start in time"
fi
logok "Ruby server running (pid $SERVER_PID)"

# --- Run TS test ---

log "Running e2e test..."
cd e2e
BOB_SK="$BOB_SK" pnpm test 2>&1
E2E_EXIT=$?
cd "$ROOT"

if [ "$E2E_EXIT" -eq 0 ]; then
    logok "E2E test passed!"
else
    echo "--- Server log ---"
    cat e2e/server.log
    die "E2E test failed (exit $E2E_EXIT)"
fi
