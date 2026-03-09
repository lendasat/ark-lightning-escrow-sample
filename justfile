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
    cargo build --release -p ark-escrow-ruby

# Install sample TS dependencies
sample-install:
    cd sample && pnpm install

# Run the HodlHodl mock server (requires ARBITER_SK env var)
server:
    cd sample && ruby server/hodlhodl.rb

# Run the happy-path demo (requires ALICE_SK, BOB_SK env vars)
happy-path:
    cd sample && pnpm happy-path
