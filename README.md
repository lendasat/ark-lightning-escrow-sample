# Ark Escrow Sample

2-of-3 Bitcoin escrow on [Arkade](https://arkade.fun) (Ark protocol). Any two of {Alice, Bob, Arbiter} can spend; the Arkade server co-signs collaborative paths.

Built as a showcase for escrow-style bitcoin↔ERC20 trades.

## Dependencies

This sample uses two external SDKs:

- **[ark-escrow](https://github.com/lendasat/ark-escrow)** — Rust crate + Ruby FFI for escrow contract, tx building, signing, and Arkade gRPC client
- **[@lendasat/lendaswap-sdk-pure](https://github.com/lendasat/lendaswap-sdk/tree/feat/ark-escrow/ts-pure-sdk)** — TS SDK for Lightning swaps + escrow signing helpers

## Components

```
ruby-ext/        Ruby FFI via Magnus — wraps ark-escrow for the Ruby server
sample/server/   Sinatra Arbiter server — trade lifecycle orchestration
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
4. **Release** — Arbiter builds release tx, signs everything, returns PSBTs to Bob
5. **Sign** — Bob signs all PSBTs in one round (`signEscrowArkTx()` + `signEscrowCheckpoints()`)
6. **Complete** — Arbiter merges signatures, submits to Arkade, finalizes

## Signing protocol (single client round-trip)

```
  Arbiter                          Bob                          Arkade
    │                               │                             │
    │ build + sign ark_tx           │                             │
    │ + sign checkpoints            │                             │
    │── all PSBTs ─────────────────>│                             │
    │<── all signed ────────────────│  (single round)             │
    │                               │                             │
    │ merge ark_tx sigs             │                             │
    │ submit(ark_tx, UNSIGNED cps) ─────────────────────────────>│
    │<──────────── server-signed cps ────────────────────────────│
    │                               │                             │
    │ merge all cp sigs             │                             │
    │ finalize(txid, merged cps) ───────────────────────────────>│
```

**Security invariant**: checkpoint signatures are never sent to Arkade before
the server co-signs the ark_tx. Only unsigned checkpoints go in the `submit`
call; arbiter + Bob checkpoint sigs are merged into the server-signed copies
afterwards.
