# Ark Escrow Sample

2-of-3 Bitcoin escrow on [Arkade](https://arkade.fun) (Ark protocol). Any two of {Alice, Bob, Arbiter} can spend; the Arkade server co-signs collaborative paths.

Built as a showcase for escrow-style bitcoin↔ERC20 trades.

## Dependencies

This sample uses two external SDKs:

- **[ark-escrow](https://github.com/lendasat/ark-escrow)** — Rust crate + Ruby FFI for escrow contract, tx building, signing, and Arkade gRPC client
- **[@satora/swap](https://github.com/satoraHQ/satora-sdk/tree/master/ts-sdk/packages/swap)** — TS SDK for Lightning swaps + escrow signing helpers

## Components

```
sample/server/   Sinatra Arbiter server — trade lifecycle orchestration
frontend/        Browser UI (Alice + Bob flows)
e2e/             Automated end-to-end test (TS → Ruby → Rust → Arkade)
```

The Ruby FFI native extension lives in the [ark-escrow](https://github.com/lendasat/ark-escrow) repo (git submodule at `ark-escrow/`).

### Escrow contract

Six taproot leaves in a weighted Huffman tree:

| # | Leaf | Signers | Condition |
|---|------|---------|-----------|
| 1 | Seller + Arbiter + Server | Collaborative spend | — |
| 2 | Buyer + Arbiter + Server | Collaborative spend | — |
| 3 | Seller + Buyer + Server | Collaborative mutual settlement | — |
| 4 | Seller + Arbiter | Unilateral spend | CSV delay |
| 5 | Buyer + Arbiter | Unilateral spend | CSV delay |
| 6 | Seller + Buyer | Unilateral mutual settlement | CSV delay |

## Prerequisites

- [Nix](https://nixos.org/) with flakes enabled
- Arkade regtest stack running (arkd at `localhost:7070`, fulmine at `localhost:7001`)

## Quick start

```sh
git submodule update --init   # fetch ark-escrow
nix develop                   # Rust 1.94, Ruby 3.3, Node 22, pnpm, just

cp .env.sample .env           # configure environment (edit as needed)
just build-ruby               # build the native extension
just install                  # install TS deps (frontend + e2e)
just e2e                      # run the full end-to-end test
```

## Configuration

Copy `.env.sample` to `.env` and adjust as needed. Key settings:

| Variable | Description |
|----------|-------------|
| `ARKADE_URL` | Arkade server URL |
| `ARKADE_TIMEOUT_MS` | Arkade request timeout in milliseconds (`0` disables timeouts) |
| `NETWORK` | `regtest`, `mutinynet`, `signet`, or `bitcoin` |
| `ARBITER_SK` | Arbiter secret key (hex) |
| `FEE_OUTPUTS_JSON` | Release fee outputs as JSON array of `[address, sats]` pairs |
| `VITE_LENDASWAP_URL` | Lendaswap API URL (for Lightning swaps) |

Fee output example:

```env
FEE_OUTPUTS_JSON='[["tark1q...",500],["tark1q...",400]]'
```

## Trade flow

1. **Create** — TS client sends Alice + Bob pubkeys → server builds escrow contract, returns address
2. **Fund** — Alice sends sats to the escrow address via Arkade
3. **Attest** — Server confirms off-chain condition (e.g. ERC20 transfer)
4. **Bob refreshes if needed** — If `release_mode` is `refresh` (or Bob ticks the sample's “refresh before claim” checkbox), Bob signs refresh PSBTs via `/refresh-bob` and the arbiter refreshes the escrow back into the same address using the `buyer_arbiter` signer set
5. **Create swap** — Bob creates the Lightning swap only after the escrow is spendable
6. **Release** — Arbiter builds release tx with signer set `buyer_arbiter`, signs everything, returns PSBTs to Bob
7. **Sign** — Bob signs all PSBTs in one round (`signEscrowArkTx()` + `signEscrowCheckpoints()`)
8. **Complete** — Arbiter merges signatures, submits to Arkade, finalizes

If the escrow VTXO has become recoverable (expired from the VTXO tree), the frontend performs an explicit escrow **refresh** before creating the Lightning swap/VHTLC, then proceeds with the normal offchain release. Bob can also tick “refresh before claim” to exercise this flow even when the escrow is already spendable; the backend logs a warning in that case.

## Release amount

The arbiter server computes the effective release amount after fee outputs. `GET /trades/:id` returns:

- `amount` — total escrow amount
- `releasable_amount` — what Bob receives after release fee outputs
- `release_mode` — `offchain` or `refresh`

The frontend uses `releasable_amount` as the source amount when creating the Lightning swap, then quotes lendaswap to determine the correct invoice amount after Boltz fees.

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
