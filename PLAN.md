# Ark Lightning Escrow — Plan

## Goal

Demonstrate how HodlHodl can use **Lendaswap** and **Arkade** for bitcoin↔ERC20 escrow trades where both sides fund and withdraw via Lightning.

### Happy Path

1. Alice and Bob agree to swap bitcoin for an ERC20 token.
2. HodlHodl creates a **2-of-3 escrow contract** on Arkade (Alice, Bob, HodlHodl as arbiter).
3. Alice funds the escrow with bitcoin via **Lightning** (LN→Arkade swap through Lendaswap).
4. Bob sends the ERC20 token to Alice on Ethereum (simulated).
5. HodlHodl attests the token transfer, co-signs with Bob to **release** the escrow.
6. Bob receives the bitcoin to his Arkade address, then withdraws via **Lightning** (Arkade→LN swap through Lendaswap).

## Escrow Contract Design

**2-of-3 multisig**: any 2 of {Alice, Bob, HodlHodl} can spend. The Arkade server is involved at the protocol level (round participation for off-chain spends), not in the condition scripts.

Four taproot leaves:

| Leaf | Script | Signers | Purpose |
|------|--------|---------|---------|
| 1 | `multisig_2of2` | Alice + Bob | Mutual settlement, no arbiter needed |
| 2 | `multisig_2of2` | Alice + HodlHodl | Arbiter-assisted refund to Alice |
| 3 | `multisig_2of2` | Bob + HodlHodl | Arbiter-assisted release to Bob **(happy path)** |
| 4 | `cltv + checksig` | Alice (after timeout) | Safety net: funder recovers if escrow never resolves |

## Architecture

```
 Alice (TS)               HodlHodl (Ruby)              Bob (TS)              Lendaswap       Arkade
   │                          │                          │                       │              │
   │── create trade ─────────▶│◀── create trade ─────────│                       │              │
   │   (alice_pk)             │    (bob_pk)              │                       │              │
   │                          │                          │                       │              │
   │                    derive escrow address             │                       │              │
   │                   (escrow crate via Magnus)          │                       │              │
   │◀── escrow addr ──────────│──── escrow addr ────────▶│                       │              │
   │                          │                          │                       │              │
   │── pay LN invoice ─────────────────────────────────────────────────────────▶│              │
   │                          │                          │                       │── fund VTXO ▶│
   │                          │                          │                       │ (to escrow)  │
   │                          │                          │                       │              │
   │       ···················· Bob sends ERC20 (simulated) ····················│              │
   │                          │                          │                       │              │
   │                    attest trade OK                   │                       │              │
   │                    sign release (Magnus)             │                       │              │
   │                          │── partial sig ──────────▶│                       │              │
   │                          │                          │── co-sign + submit ──────────────────▶│
   │                          │                          │  (TS SDK escrow mod)  │ (new VTXO   │
   │                          │                          │                       │  to Bob)     │
   │                          │                          │── withdraw via LN ───▶│              │
   │                          │                          │◀── LN payment ────────│◀─────────────│
```

## Deliverables

### 1. `escrow/` — Rust library crate (this repo)

Pure Rust escrow logic. Depends on `ark-core` from crates.io.

```
escrow/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── contract.rs     # EscrowOptions → taproot scripts → ArkAddress
    └── spend.rs        # Signing logic for release/refund/mutual spend
```

**Key types:**

```rust
pub struct EscrowOptions {
    pub alice: XOnlyPublicKey,     // funder
    pub bob: XOnlyPublicKey,       // recipient
    pub arbiter: XOnlyPublicKey,   // HodlHodl
    pub refund_timeout: u32,       // CLTV block height for safety refund
    pub network: Network,
}

pub struct EscrowContract {
    pub options: EscrowOptions,
    pub spend_info: TaprootSpendInfo,
}

impl EscrowContract {
    pub fn new(opts: EscrowOptions) -> Result<Self>;
    pub fn address(&self) -> ArkAddress;
    pub fn scripts(&self) -> EscrowScripts;
}
```

**Spend paths:**

```rust
/// Sign a 2-of-2 escrow spend (one party's signature).
/// The other party signs separately; both sigs are combined to spend.
pub fn sign_spend(
    contract: &EscrowContract,
    leaf: EscrowLeaf,           // MutualSettle | RefundToAlice | ReleaseToBob
    keypair: &Keypair,
    vtxo_outpoint: OutPoint,
    dest_address: ArkAddress,
    amount: Amount,
) -> Result<PartialSpend>;
```

### 2. `ruby-ext/` — Magnus bindings (this repo)

Wraps `escrow/` for the HodlHodl Ruby backend.

```
ruby-ext/
├── Cargo.toml           # cdylib, depends on escrow + magnus + serde_magnus
├── src/
│   └── lib.rs           # #[magnus::init] — Ruby classes
├── lib/
│   └── ark_escrow.rb    # Ruby require shim
├── Gemfile
├── Rakefile
└── ark_escrow.gemspec
```

**Ruby API:**

```ruby
contract = ArkEscrow::Contract.new(
  alice_pk: "ab12...",
  bob_pk: "cd34...",
  arbiter_pk: "ef56...",
  refund_timeout: 850_000,
  network: "signet"
)

contract.address  # => "ark1q..."

# HodlHodl signs release (leaf 3: Bob + HodlHodl)
partial = contract.sign_release(
  arbiter_secret_key: "...",
  vtxo_outpoint: "txid:vout",
  dest_address: "ark1q...",   # Bob's address
  amount_sats: 100_000
)
# => { sig: "...", leaf_script: "...", control_block: "..." }
```

### 3. Lendaswap TS SDK `escrow/` module (in lendaswap2 repo)

New module in `client-sdk/ts-pure-sdk/src/escrow/`:

```
src/escrow/
├── index.ts
├── types.ts          # EscrowParams, EscrowSpendRequest, PartialSpend
├── release.ts        # Bob co-signs HodlHodl's partial sig, submits to Arkade
└── refund.ts         # Alice co-signs HodlHodl's partial sig, submits to Arkade
```

**TS API:**

```typescript
// Bob receives partial signature from HodlHodl, co-signs and submits
const txid = await escrow.release({
  arkServerUrl: "https://signet.arkade.computer",
  escrowParams: { alicePk, bobPk, arbiterPk, refundTimeout, network },
  partialSpend: hodlhodlResponse.partialSpend,   // from HodlHodl API
  bobSecretKey: bobSk,
  destAddress: bobArkAddress,
  amount: 100_000n,
});
```

### 4. `sample/` — End-to-end demo (this repo)

```
sample/
├── package.json
├── tsconfig.json
└── src/
    ├── happy-path.ts        # Orchestrates full flow
    └── mock/
        ├── lendaswap.ts     # Stubs for LN↔Arkade swaps
        └── hodlhodl.ts      # Mock HodlHodl REST API
```

### 5. HodlHodl Mock REST API (in sample)

Simple API that the demo uses:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /trades` | Create | Alice + Bob public keys → escrow address |
| `GET /trades/:id` | Read | Trade status, escrow address |
| `POST /trades/:id/attest` | Attest | HodlHodl confirms ERC20 sent |
| `POST /trades/:id/release` | Release | Returns HodlHodl's partial sig for Bob |
| `POST /trades/:id/refund` | Refund | Returns HodlHodl's partial sig for Alice |

## Execution Order

1. **`escrow/`** — Rust crate with unit tests. Foundation for everything else.
2. **`ruby-ext/`** — Magnus bindings. Test from Ruby.
3. **TS SDK `escrow/` module** — In lendaswap2 repo. Uses `@arkade-os/sdk` + `@scure/btc-signer`.
4. **`sample/`** — Ties it all together. LN↔Arkade swaps mocked until ready.

## Dependencies

- `ark-core = "0.8.0"` from crates.io (escrow crate)
- `magnus = "0.8"` (Ruby FFI)
- `@arkade-os/sdk = "^0.3.12"` (TS SDK)
- `@scure/btc-signer` (taproot signing in TS)

## Open Items

- [ ] Ark protocol details for custom-script VTXO off-chain spends (how exactly does the Arkade server verify and process a 2-of-2 leaf spend?)
- [ ] Whether `Vtxo::new_with_custom_scripts` from `ark-core` is the right entry point for creating escrow VTXOs, or if we go through `ark-client` send flow
- [ ] Exact serialization format for partial signatures exchanged between HodlHodl and clients
- [ ] Integration testing against regtest (blocked on LN↔Arkade swap support in Lendaswap)
