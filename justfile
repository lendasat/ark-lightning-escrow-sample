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

# Install sample TS dependencies
sample-install:
    cd sample && pnpm install

# Run the HodlHodl mock server (requires ARBITER_SK env var)
server:
    cd sample && ruby server/hodlhodl.rb

# Run the happy-path demo (requires ALICE_SK, BOB_SK env vars)
happy-path:
    cd sample && pnpm happy-path

# Run the full e2e test (TS → Ruby/Magnus → Rust → Arkade)
# Requires: nigiri + arkd + fulmine running
e2e:
    ./e2e/run.sh
