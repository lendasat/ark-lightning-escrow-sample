check:
    cargo check

test:
    cargo test

clippy:
    cargo clippy

fmt:
    cargo fmt

lint: fmt clippy
