set dotenv-load

ARK_ESCROW_DIR := env("ARK_ESCROW_DIR", justfile_directory() / ".." / "ark-escrow")

# Build the native extension for Ruby (from ark-escrow repo)
build-ruby:
    cd {{ARK_ESCROW_DIR}} && cargo build -p ark-escrow-ruby
    @# Symlink without lib prefix so Ruby's Init_ function name matches.
    @# macOS produces .dylib, Linux produces .so — Ruby needs .bundle on macOS, .so on Linux.
    @cd {{ARK_ESCROW_DIR}}/target/debug && \
      if [ -f libark_escrow_ruby.dylib ]; then \
        ln -sf libark_escrow_ruby.dylib ark_escrow_ruby.bundle; \
      else \
        ln -sf libark_escrow_ruby.so ark_escrow_ruby.so; \
      fi

build-ruby-release:
    cd {{ARK_ESCROW_DIR}} && cargo build --release -p ark-escrow-ruby
    @cd {{ARK_ESCROW_DIR}}/target/release && \
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
# Override with env vars: ARKADE_URL, ARBITER_PORT, FRONTEND_PORT, ARBITER_SK

ARKADE_URL       := env("ARKADE_URL", "http://localhost:7070")
NETWORK          := env("NETWORK", "regtest")
ARBITER_PORT    := env("ARBITER_PORT", "4567")
FRONTEND_PORT    := env("FRONTEND_PORT", "3001")
ARBITER_SK       := env("ARBITER_SK", "0000000000000000000000000000000000000000000000000000000000000001")
VITE_ARBITER_URL   := env("VITE_ARBITER_URL", "http://localhost:" + ARBITER_PORT)
VITE_ARKADE_URL     := env("VITE_ARKADE_URL", ARKADE_URL)
VITE_LENDASWAP_URL  := env("VITE_LENDASWAP_URL", "http://localhost:7071")
VITE_NETWORK        := env("VITE_NETWORK", NETWORK)
VITE_EXPLORER_URL   := env("VITE_EXPLORER_URL", "")

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
      bundle exec ruby arbiter.rb -o 127.0.0.1 -p {{ARBITER_PORT}} > /tmp/arbiter.log 2>&1 &) &
    sleep 1 && pgrep -f "arbiter.rb" | head -1 > /tmp/arbiter.pid
    echo "Starting frontend..."
    (cd {{ROOT}}/frontend && \
      VITE_ARBITER_URL={{VITE_ARBITER_URL}} \
      VITE_ARKADE_URL={{VITE_ARKADE_URL}} \
      VITE_LENDASWAP_URL={{VITE_LENDASWAP_URL}} \
      VITE_NETWORK={{VITE_NETWORK}} \
      VITE_EXPLORER_URL={{VITE_EXPLORER_URL}} \
      pnpm exec vite --port {{FRONTEND_PORT}} > /tmp/frontend.log 2>&1 &) &
    sleep 1 && pgrep -f "vite.*{{FRONTEND_PORT}}" | head -1 > /tmp/frontend.pid
    sleep 2
    echo ""
    echo "  Ruby server:  http://localhost:{{ARBITER_PORT}}  (pid $(cat /tmp/arbiter.pid))"
    echo "  Frontend:     http://localhost:{{FRONTEND_PORT}}  (pid $(cat /tmp/frontend.pid))"
    echo ""
    echo "  Alice: http://localhost:{{FRONTEND_PORT}}/alice.html"
    echo "  Bob:   http://localhost:{{FRONTEND_PORT}}/bob.html"
    echo ""
    echo "  Logs:  just logs"
    echo "  Stop:  just down"

# Rebuild + restart just the Ruby server (keeps frontend running)
restart-server: build-ruby
    #!/usr/bin/env bash
    pkill -f "arbiter.rb" 2>/dev/null && echo "Stopped old server" || true
    sleep 0.5
    (cd {{ROOT}}/sample/server && \
      ARBITER_SK={{ARBITER_SK}} \
      ARKADE_URL={{ARKADE_URL}} \
      NETWORK={{NETWORK}} \
      FORCE_DELEGATE=${FORCE_DELEGATE:-0} \
      DELEGATE_COSIGNER_SK=${DELEGATE_COSIGNER_SK:-{{ARBITER_SK}}} \
      bundle exec ruby arbiter.rb -o 127.0.0.1 -p {{ARBITER_PORT}} > /tmp/arbiter.log 2>&1 &) &
    sleep 2
    pgrep -f "arbiter.rb" | head -1 > /tmp/arbiter.pid
    echo "Server restarted: http://localhost:{{ARBITER_PORT}}  (pid $(cat /tmp/arbiter.pid))"

# Stop everything
down:
    #!/usr/bin/env bash
    for name in arbiter frontend; do
      if [ -f /tmp/${name}.pid ]; then
        pid=$(cat /tmp/${name}.pid)
        kill $pid 2>/dev/null && echo "Stopped $name (pid $pid)" || echo "$name not running"
        rm -f /tmp/${name}.pid
      fi
    done
    pkill -f "arbiter.rb" 2>/dev/null || true
    pkill -f "vite.*frontend" 2>/dev/null || true

# View logs
logs:
    tail -f /tmp/arbiter.log /tmp/frontend.log

# Run the full e2e test (TS → Ruby/Magnus → Rust → Arkade)
e2e:
    ./e2e/run.sh
