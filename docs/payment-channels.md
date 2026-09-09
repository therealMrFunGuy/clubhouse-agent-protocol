# Running the payment-channel facilitator

Per-move metering uses x402's `batch-settlement` scheme: an agent deposits once, signs an off-chain
voucher per move, and the receiver redeems the accumulated vouchers in one on-chain claim.

> **Which half of the system this describes.** The channel manager needs Redis, chain access and a
> signing key, so it runs on the **private origin**, not on the edge Worker. What is open here is
> [`packages/channel-manager`](../packages/channel-manager): the manager wiring, the claim-ceiling
> breaker (`selectWithinCeiling`), the `AuthorizerSigner` interface with its local and remote
> implementations, and `claimsOnly` — the wrapper that refuses to sign a refund. Those you can
> install, read and run.
>
> Two functions named below are **origin-side and not in this repository**:
> `keySeparationFailures` and the claim job's `selectRefundChannels`. They are named so you can ask
> about them by name, not because you can grep for them here, and each is flagged again at the point
> it is used.

**We run our own facilitator so that the key which signs claims stays ours.**
Probed 2026-09-08, corrected twice on 2026-09-09:

| Facilitator | Schemes | batch-settlement |
|---|---|---|
| `facilitator.payai.network` | `exact` | no |
| `facilitator.daydreams.systems` | `exact`, `upto` | no |
| `facilitator.heurist.xyz` | `exact` | no |
| `facilitator.xpay.sh` | `exact` | no |
| `x402.org/facilitator` | `exact`, `upto`, `batch-settlement` | **Base Sepolia only** |
| `facilitator.dexter.cash` | `exact`, `tab`, `upto`, `batch-settlement`, `bridge` | **yes — 6 EVM mainnets** |
| `api.cdp.coinbase.com` (Coinbase) | `exact`, `upto`, `batch-settlement` | **yes — Base mainnet + 5 more** |

> ⚠️ **This page used to say no public facilitator served the scheme on any mainnet. That was
> wrong.** Dexter serves `batch-settlement` on Base, Polygon, Arbitrum, World Chain, Monad and one
> other, free and without an account, and had done so for roughly two months before we first probed.
> The original probe missed it, and a later pass misread it as `exact`-only because
> `facilitator.dexter.cash` answers `308` and the body was read without following the redirect. A
> probe that returns *something* is not a probe that returned *the answer*.

> ⚠️ **Corrected a second time, hours later.** The first fix said the reason was price — Dexter's
> floor is 1079 base units and a metered move is 500 — and concluded "no public facilitator will
> process a payment as small as ours". That generalised from one facilitator, which is the same
> mistake in the same shape. Probed with a real CDP key: CDP serves `batch-settlement` on Base and
> advertises **no minimum payment at all**, so it would very likely take our 500.

The real reason is the authorizer. CDP's batch-settlement offer carries its own:

```
extra.receiverAuthorizer = 0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb
```

Using it means the key that signs `ClaimBatch` is theirs. `refundWithSignature` takes **no payer
signature**, so an unrestricted authorizer can push funds out of any channel — which is why ours is
refused `Refund` in code. Delegating that is not a configuration change, it is a change of who can
take the money. It could not be retrofitted anyway: `computeChannelId` binds the channelConfig,
authorizer included, so every existing channel is tied to the authorizer it opened with.

Dexter's 1079 floor is still true and still rules Dexter out for per-move pricing. It is simply not
the general rule the previous version of this page claimed.

The entry fee is a different matter — `exact` at 500000 base units clears any floor easily, so
routing *that* through a public facilitator is a real option, and it is how Bazaar indexing is
earned.

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

They must be **three separate keys**, and startup refuses to report ready if any two are the same.
The check is `keySeparationFailures`, on the private origin — not in this repository. It runs at
readiness rather than at claim time, because by claim time the vouchers are already taken. What you
can observe from outside is its verdict: `GET /v1/status` reports metering as not ready, and names
what is wrong.

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

Not by configuration — there is no flag. `claimsOnly()` wraps the signer and throws before the
request reaches whatever holds the key, so even a compromised process cannot obtain a refund
signature from a signing service that would otherwise have produced one. It is an allow-list
(`ClaimBatch`), so a message type the contract gains later is refused until somebody deliberately
allows it.

`claimsOnly` is in
[`packages/channel-manager/src/signer.ts`](../packages/channel-manager/src/signer.ts), in this
repository, and **both** signers that package exports — local and remote — are wrapped in it before
they are returned. There is no constructor option to disable it: a flag that allows refunds is a
flag somebody sets at 2am to unstick something.

That location matters and was wrong until recently. This document, and the README, stated as fact
that the authorizer is refused by code rather than by policy — which was true of the private
platform repo and false of the package anybody can actually install and audit. A control a
researcher can neither see nor run is not a control. Install the package, hand a `Refund` to either
signer, and watch it throw `RefundRefused` before a socket is opened or a bearer token leaves the
process.

One rough edge: `claimsOnly` and `RefundRefused` are not re-exported from the package entry point,
so you get the behaviour through the signer factories but cannot import the wrapper by name or catch
the error by its class. Read `packages/channel-manager/src/signer.ts` directly to audit it.

The private origin wraps its own authorizer in the same function. If a finding turns on the origin
side specifically, say so in the report and we will answer about it directly.

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
  raise deliberately, or something wrong. The selection function that applies it, `selectWithinCeiling`,
  **is** in this repository — [`packages/channel-manager/src/breaker.ts`](../packages/channel-manager/src/breaker.ts),
  with its tests — so the arithmetic of the bound is readable and auditable in full.
- **Refunds are never selected.** The claim job's `selectRefundChannels` returns nothing, always, so
  the authorizer is never asked for a signature it would refuse. That job is **origin-side and not
  in this repository**; it is the belt to `claimsOnly`'s braces, and `claimsOnly` is the half you
  can audit.

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
to permit2.

The first reading of that table was "payai is broken". It is not. Our own
facilitator runs the same reference `ExactEvmScheme` and returns the same
answer, so this is the library: **permit2 verification checks the signature and
does not check that the payer can pay.** xpay adds its own check on top, which is
what made a shared gap look like a disagreement.

Two things have changed since, and this section used to describe neither:

- **The gateway no longer defaults to payai.** It builds its own facilitator and
  passes it to `getPaymentServer`; a public one is used only when
  `X402_FACILITATOR_URL` is set, which is the escape hatch for taking ours out of
  the loop in a hurry. See `getPaymentServer` in `gateway/src/x402.ts`.
- **WETH and CRED are enabled**, not pending. The gap above is closed on the
  origin side by an explicit on-chain read of the payer's balance and Permit2
  allowance before a permit2 payment is accepted, with a refusal that names which
  of the two is missing. That closes the free-seat case; it does not close the
  verify/settle race, which settlement reporting absorbs.

Re-probe rather than trusting this table: it describes somebody else's service on
one particular day.

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
