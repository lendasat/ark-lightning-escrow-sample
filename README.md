# Ark Escrow Sample

2-of-3 Bitcoin escrow on [Arkade](https://arkade.fun) (Ark protocol). Any two of {Alice, Bob, Arbiter} can spend; the Arkade server co-signs collaborative paths.

Built as a showcase for HodlHodl-style bitcoin↔ERC20 trades.

## Dependencies

This sample uses two external SDKs:

- **[ark-escrow](https://github.com/lendasat/ark-escrow)** — Rust crate + Ruby FFI for escrow contract, tx building, signing, and Arkade gRPC client
- **[@lendasat/lendaswap-sdk-pure](https://github.com/lendasat/lendaswap-sdk/tree/feat/ark-escrow/ts-pure-sdk)** — TS SDK for Lightning swaps + escrow signing helpers

## Components

```
ruby-ext/        Ruby FFI via Magnus — wraps ark-escrow for the Ruby server
sample/server/   Sinatra mock HodlHodl — trade lifecycle orchestration
frontend/        Browser UI (Alice + Bob flows)
e2e/             Automated end-to-end test (TS → Ruby → Rust → Arkade)
```

### Escrow contract

Six taproot leaves in a weighted Huffman tree:

| # | Leaf | Signers | Condition |
|---|------|---------|-----------|
| 1 | Alice + Arbiter + Server | Collaborative refund | — |
| 2 | Bob + Arbiter + Server | Collaborative release | — |
| 3 | Alice + Bob + Server | Collaborative mutual settlement | — |
| 4 | Alice + Arbiter | Unilateral refund | CSV delay |
| 5 | Bob + Arbiter | Unilateral release | CSV delay |
| 6 | Alice + Bob | Unilateral mutual settlement | CSV delay |

## Prerequisites

- [Nix](https://nixos.org/) with flakes enabled
- Arkade regtest stack running (arkd at `localhost:7070`, fulmine at `localhost:7001`)

## Quick start

```sh
nix develop          # Rust 1.94, Ruby 3.3, Node 22, pnpm, just

just build-ruby      # build the native extension
just install         # install TS deps (frontend + e2e)
just e2e             # run the full end-to-end test
```

## Trade flow

1. **Create** — TS client sends Alice + Bob pubkeys → server builds escrow contract, returns address
2. **Fund** — Alice sends sats to the escrow address via Arkade
3. **Attest** — Server confirms off-chain condition (e.g. ERC20 transfer)
4. **Release** — Server builds release tx, returns PSBTs to Bob
5. **Sign** — Bob signs ark_tx and checkpoint PSBTs using `signEscrowArkTx()` / `signEscrowCheckpoints()`
6. **Submit + Finalize** — Server merges signatures, submits to Arkade, finalizes

## Signing protocol

```
Server (arbiter) signs ark_tx  ──┐
Bob signs ark_tx                 ├─► merge → submit to Arkade
                                 │
Arkade returns server-signed     │
checkpoint PSBTs                 │
                                 │
Server signs checkpoints  ───────┤
Bob signs checkpoints            ├─► merge → finalize on Arkade
```
