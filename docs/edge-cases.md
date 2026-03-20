# Edge Cases

A list of things outside the happy path.

## Boltz fails to create entry Lightning invoice

- Retry creating the LN-Arkade swap (client-side).

## Entry Lightning invoice expiry

- Retry creating the LN-Arkade swap (client-side).

## Escrow server fails to complete 2-step offchain transaction protocol (to claim or refund)

- Once the offchain transaction has been registered with the server, if the finalization doesn't happen (transient error), one cannot just use the same VTXO as an input in another offchain transaction.
- To retry one has to use the `GetPendingTxs` API on the Arkade server/indexer. That returns the original Arkade transaction + checkpoint transactions, and the arbiter can retry finalization.

_Our libraries should help you with this. To be implemented._

## Escrow contract expires and becomes recoverable

- Instead of offchain transaction (no longer possible when in recoverable state), join an Arkade batch (settlement) via the arbiter backend (we do this in Lendasat and LendaSwap, for example).
- To optimise this we use a delegate approach (Arkade implementation detail).
- It's just another mode of *spending* in Arkade.

_Our libraries should help you with this. To be implemented._

## Boltz fails to pay exit Lightning invoice

- After the exit VHTLC has been funded (transaction from escrow to VHTLC), if Boltz encounters an error paying the Lightning invoice, the only way to continue is to refund the VHTLC (collaboratively with Boltz for convenience/speed or unilaterally after a timelock expires).
- Lendaswap *could* offer a feature to retry, by routing the refund into another Boltz VHTLC (a new Arkade-LN swap).
- Alternatively, refund could go into an Arkade wallet for the client. Retry would then be executed at that level instead.
- Since the Boltz VHTLC is just another type of VTXO, it can also expire and become recoverable. In such a scenario, refund would require settlement (either independently on the client or aided by the escrow server, which isn't involved in that VHTLC, but can help via Arkade delegate system).

_Our libraries should help you with this. To be implemented._

## Unilateral exit in case Arkade is down or loss of confidence

Usually not exposed directly to the client (inconvenient, hard UX), but it should be made possible (for example through an escrow recovery tool).

_Our libraries should help you with this. To be implemented._

## Arbiter refuses to sign

- Alice and Bob can cooperate (outside of the platform).
- An escrow recovery tool (similar to the one used when Arkade disappears, but with offchain transactions as a default) can facilitate this.

_Our libraries should help you with this. To be implemented._
