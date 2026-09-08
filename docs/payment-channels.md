# Running the payment-channel facilitator

Per-move metering uses x402's `batch-settlement` scheme: an agent deposits once, signs an off-chain
voucher per move, and the receiver redeems the accumulated vouchers in one on-chain claim.

**No public facilitator serves that scheme on any mainnet.** Probed 2026-09-08:

| Facilitator | Schemes | batch-settlement |
|---|---|---|
| `facilitator.payai.network` | `exact` | no |
| `facilitator.daydreams.systems` | `exact`, `upto` | no |
| `facilitator.heurist.xyz` | `exact` | no |
| `facilitator.xpay.sh` | `exact` | no |
| `x402.org/facilitator` | `exact`, `upto`, `batch-settlement` | **Base Sepolia only** |

The contracts, however, are deployed and verified on Base mainnet — canonical x402 CREATE2
deployments, not ours:

```
batchSettlement            0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003   11175 bytes
erc3009DepositCollector    0x4020806089470a89826cB9fB1f4059150b550004
permit2DepositCollector    0x4020425FAf3B746C082C2f942b4E5159887B0005
```

So metering is not blocked by a missing dependency. It needs a facilitator, and the only way to have
one is to be one.

## The three keys

They must be **three separate keys**, and startup refuses to report ready if any two are the same —
see `keySeparationFailures`. This is checked at readiness rather than at claim time, because by then
the vouchers are already taken.

| Role | Holds | Signs | Env |
|---|---|---|---|
| **Submitter** | gas on Base | nothing off-chain; broadcasts what it is handed | `AGENT_CHANNEL_SUBMITTER_KEY` |
| **Authorizer** | nothing | `ClaimBatch` only | `AGENT_CHANNEL_AUTHORIZER_KEY`, or a signing service |
| **Receiver** | the agent pot | nothing *in this scheme* | `AGENT_POT_ADDRESS` |

The receiver is never asked for a signature by the batch-settlement contract — only the authorizer
is. On this platform the pot is also the wallet winners are paid from, so its key does sign
elsewhere; that is deliberate, because a pot nobody can pay out of is the one failure you cannot
undo. It does mean claimed channel funds land in a hot wallet, which is the same exposure entry fees
already have.

**None of them may be the platform's payout key.** That key already signs prize transfers for every
chain from inside the web process; giving it a second job in a component facing unbounded agent
traffic widens a blast radius that is already too wide. This is checked too.

### Why the authorizer is the one to worry about

On the **claim** path this key is bounded by the contract. Every claim tuple carries the payer's own
EIP-712 voucher signature and the contract tracks `totalClaimed` per channel, so a stolen authorizer
cannot invent a debt, cannot exceed `maxClaimableAmount`, and gains nothing from replaying a claim.

On the **refund** path it is not bounded at all. `refundWithSignature` takes **no payer signature**.
The receiver-authorizer alone can push funds out of any channel, immediately, bypassing the withdraw
delay. Funds go back to each channel's payer rather than to a thief — which sounds reassuring and is
not, because agents self-register, so an attacker trivially *is* a payer: open channels, run up an
unbounded tab across them, then refund. Direct, self-directed profit.

So:

> **The authorizer is refused the ability to sign `Refund`, in code.**

Not by configuration — there is no flag. `claimsOnly()` throws before the request reaches whatever
holds the key, so even a compromised process cannot obtain a refund signature from a signing service
that would otherwise have produced one. It is an allow-list (`ClaimBatch`), so a message type the
contract gains later is refused until somebody deliberately allows it.

If you later put this key behind a KMS, give it the same policy there. This stays as the backstop.

**What refusing costs:** agents lose the fast cooperative exit and use the contract's own withdraw
path instead, which is enforced on-chain, needs nothing from us, and completes after the withdraw
delay (we set one hour; the contract floor is fifteen minutes). They wait; they do not lose anything.

### Preferring a signing service

The key does not need to be in the web process at all:

```
AGENT_CHANNEL_AUTHORIZER_URL=https://signer.internal/sign
AGENT_CHANNEL_AUTHORIZER_TOKEN=...
AGENT_CHANNEL_AUTHORIZER_ADDRESS=0x...
```

HTTPS or loopback only. The response's address is checked against the configured one, so a swapped
service signing with a different key fails loudly instead of producing claims against channels that
were opened for somebody else.

## Turning it on

```
AGENT_CHANNEL_SUBMITTER_KEY=...        # fund with gas on Base
AGENT_CHANNEL_AUTHORIZER_KEY=...       # or the three _URL/_TOKEN/_ADDRESS vars
AGENT_POT_ADDRESS=0x...                # the receiver; already set for entry fees
BASE_RPC_URL=...                       # or BASE_ALCHEMY_URL
AGENT_CHANNELS_ENABLED=1               # last, and deliberately separate
```

`AGENT_CHANNELS_ENABLED` is its own switch on purpose. Everything else can be present and metering
stays off until somebody turns it on: switching on a money path should be an act, not a side effect
of configuration drifting into place.

`GET /v1/status` reports `metering` — whether it is live, which facilitator, whether the authorizer
is local or remote, and precisely what is missing when it is not. Check there rather than guessing.

## Claiming

Claims run from a scheduled call to `/api/cron/agent-channel-claims`, not from a timer inside the
web process. Two workers each running the library's own interval loop would claim the same channels
twice, and a deploy landing mid-cycle would strand whatever was decided but not submitted. One
scheduled caller, one run at a time behind a Redis lock.

Two bounds worth knowing:

- **A per-run ceiling** (`AGENT_CHANNEL_CLAIM_CEILING_BASE`, default 50 USDC). Claiming is the only
  step that moves money, so if a bug or an attack inflates what we believe is owed, the loss is a
  number chosen in advance. Deferred channels are claimed next run; their vouchers stay valid and
  nothing is forfeited. Hitting the ceiling logs loudly — it means either real growth, which you
  raise deliberately, or something wrong.
- **Refunds are never selected.** `selectRefundChannels` returns nothing, always, so the authorizer
  is never asked for a signature it would refuse.

## ⚠️ Facilitators disagree about permit2

Probed 2026-09-08 with a real, well-formed `exact` permit2 payment for WETH,
signed by a wallet holding nothing:

| Facilitator | Verdict | Correct? |
|---|---|---|
| `xpay.sh` | `insufficient_funds` | yes — parsed it and checked the chain |
| `heurist.xyz` | `invalid_asset_address` | refuses WETH outright |
| `payai` | **`isValid: true`** | **no — approved a payment that cannot settle** |

The same probe on the USDC/EIP-3009 path has all three refusing correctly, so
**the path running in production today is sound.** The disagreement is specific
to permit2, which payai evidently does not validate.

payai is the gateway's default facilitator. Enabling a permit2 asset while
pointed at it would grant seats for payments that never settle — recoverable,
since a failed settlement voids the seat and keeps it out of the pot, but a
free-seat griefing vector and constant churn for nothing.

**So: if WETH or CRED are ever enabled, the facilitator must be one that
demonstrably validates permit2.** Re-probe rather than trusting this table; it
describes somebody else's service on one particular day.

Two further frictions found the same way, both client-side:

- The `exact` client **requires an EIP-712 `name`/`version` for the asset even
  under permit2**, and WETH has neither (no `version()`, no `DOMAIN_SEPARATOR`).
  A synthetic domain does let the payment build, but it is a guess.
- A client refuses non-default assets unless the operator sets
  `spendControls.allowedAssets`. Enabling an asset server-side is therefore not
  sufficient; agents must opt in too.

## Proving it before mainnet

Point a paper environment at Base Sepolia and x402.org's facilitator, which serves the scheme there
for free and needs none of the three keys. That exercises deposit, voucher, verify and claim against
an independent implementation — a useful cross-check that our facilitator agrees with somebody
else's before it is the only one in the loop.
