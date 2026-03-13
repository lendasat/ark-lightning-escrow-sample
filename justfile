set dotenv-load

check:
    cargo check

test:
    cargo test

clippy:
    cargo clippy

fmt:
    cargo fmt

lint: fmt clippy

# Build the native extension for Ruby
build-ruby:
    cargo build -p ark-escrow-ruby
    @# Symlink without lib prefix so Ruby's Init_ function name matches.
    @# macOS produces .dylib, Linux produces .so — Ruby needs .bundle on macOS, .so on Linux.
    @cd target/debug && \
      if [ -f libark_escrow_ruby.dylib ]; then \
        ln -sf libark_escrow_ruby.dylib ark_escrow_ruby.bundle; \
      else \
        ln -sf libark_escrow_ruby.so ark_escrow_ruby.so; \
      fi

build-ruby-release:
    cargo build --release -p ark-escrow-ruby
    @cd target/release && \
      if [ -f libark_escrow_ruby.dylib ]; then \
        ln -sf libark_escrow_ruby.dylib ark_escrow_ruby.bundle; \
      else \
        ln -sf libark_escrow_ruby.so ark_escrow_ruby.so; \
      fi

# Install all JS dependencies
install:
    cd frontend && pnpm install
    cd e2e && pnpm install

# --- Demo environment ---
# Requires: nigiri + arkd + fulmine running (regtest stack)
# Override with env vars: ARKADE_URL, HODLHODL_PORT, FRONTEND_PORT, ARBITER_SK

ARKADE_URL       := env("ARKADE_URL", "http://localhost:7070")
NETWORK          := env("NETWORK", "regtest")
HODLHODL_PORT    := env("HODLHODL_PORT", "4567")
FRONTEND_PORT    := env("FRONTEND_PORT", "3001")
ARBITER_SK       := env("ARBITER_SK", "0000000000000000000000000000000000000000000000000000000000000001")
VITE_HODLHODL_URL  := env("VITE_HODLHODL_URL", "http://localhost:" + HODLHODL_PORT)
VITE_ARKADE_URL   := env("VITE_ARKADE_URL", ARKADE_URL)
VITE_EXPLORER_URL := env("VITE_EXPLORER_URL", "")

# Start the Ruby server + frontend (background)
ROOT := justfile_directory()

up: build-ruby
    #!/usr/bin/env bash
    just down 2>/dev/null || true
    echo "Starting Ruby server..."
    cd {{ROOT}}/sample/server && bundle install --quiet
    (cd {{ROOT}}/sample/server && \
      ARBITER_SK={{ARBITER_SK}} \
      ARKADE_URL={{ARKADE_URL}} \
      NETWORK={{NETWORK}} \
      bundle exec ruby hodlhodl.rb -o 127.0.0.1 -p {{HODLHODL_PORT}} > /tmp/hodlhodl.log 2>&1 &) &
    sleep 1 && pgrep -f "hodlhodl.rb" | head -1 > /tmp/hodlhodl.pid
    echo "Starting frontend..."
    (cd {{ROOT}}/frontend && \
      VITE_HODLHODL_URL={{VITE_HODLHODL_URL}} \
      VITE_ARKADE_URL={{VITE_ARKADE_URL}} \
      VITE_EXPLORER_URL={{VITE_EXPLORER_URL}} \
      pnpm exec vite --port {{FRONTEND_PORT}} > /tmp/frontend.log 2>&1 &) &
    sleep 1 && pgrep -f "vite.*{{FRONTEND_PORT}}" | head -1 > /tmp/frontend.pid
    sleep 2
    echo ""
    echo "  Ruby server:  http://localhost:{{HODLHODL_PORT}}  (pid $(cat /tmp/hodlhodl.pid))"
    echo "  Frontend:     http://localhost:{{FRONTEND_PORT}}  (pid $(cat /tmp/frontend.pid))"
    echo ""
    echo "  Alice: http://localhost:{{FRONTEND_PORT}}/alice.html"
    echo "  Bob:   http://localhost:{{FRONTEND_PORT}}/bob.html"
    echo ""
    echo "  Logs:  just logs"
    echo "  Stop:  just down"

# Stop everything
down:
    #!/usr/bin/env bash
    for name in hodlhodl frontend; do
      if [ -f /tmp/${name}.pid ]; then
        pid=$(cat /tmp/${name}.pid)
        kill $pid 2>/dev/null && echo "Stopped $name (pid $pid)" || echo "$name not running"
        rm -f /tmp/${name}.pid
      fi
    done
    pkill -f "hodlhodl.rb" 2>/dev/null || true
    pkill -f "vite.*frontend" 2>/dev/null || true

# View logs
logs:
    tail -f /tmp/hodlhodl.log /tmp/frontend.log

# Run the full e2e test (TS → Ruby/Magnus → Rust → Arkade)
e2e:
    ./e2e/run.sh
