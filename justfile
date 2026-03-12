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
    @# Symlink without lib prefix so Ruby's Init_ function name matches
    @cd target/debug && ln -sf libark_escrow_ruby.so ark_escrow_ruby.so

build-ruby-release:
    cargo build --release -p ark-escrow-ruby
    @cd target/release && ln -sf libark_escrow_ruby.so ark_escrow_ruby.so

# Install all JS dependencies
install:
    cd frontend && pnpm install
    cd e2e && pnpm install

# --- Demo environment ---
# Requires: nigiri + arkd + fulmine running (regtest stack)

ARBITER_SK := "0000000000000000000000000000000000000000000000000000000000000001"

# Start the Ruby server + frontend (background)
up: build-ruby
    #!/usr/bin/env bash
    just down 2>/dev/null || true
    echo "Starting Ruby server..."
    cd sample/server && bundle install --quiet
    cd sample/server && ARBITER_SK={{ARBITER_SK}} bundle exec ruby hodlhodl.rb -o 127.0.0.1 -p 4567 > /tmp/hodlhodl.log 2>&1 &
    echo $! > /tmp/hodlhodl.pid
    echo "Starting frontend..."
    cd frontend && pnpm dev > /tmp/frontend.log 2>&1 &
    echo $! > /tmp/frontend.pid
    sleep 2
    echo ""
    echo "  Ruby server:  http://localhost:4567  (pid $(cat /tmp/hodlhodl.pid))"
    echo "  Frontend:     http://localhost:3001  (pid $(cat /tmp/frontend.pid))"
    echo ""
    echo "  Alice: http://localhost:3001/alice.html"
    echo "  Bob:   http://localhost:3001/bob.html"
    echo ""
    echo "  Logs:  tail -f /tmp/hodlhodl.log /tmp/frontend.log"
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
    # Also kill any stragglers
    pkill -f "hodlhodl.rb" 2>/dev/null || true
    pkill -f "vite.*frontend" 2>/dev/null || true

# View logs
logs:
    tail -f /tmp/hodlhodl.log /tmp/frontend.log

# Run the full e2e test (TS → Ruby/Magnus → Rust → Arkade)
e2e:
    ./e2e/run.sh
