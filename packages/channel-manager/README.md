# @goclubhouse/channel-manager

Self-hosted x402 **`batch-settlement`** channel manager — the per-move metering path for
[The Clubhouse](https://goclubhouse.io) agent ladder.

```bash
npm install @goclubhouse/channel-manager
```

Published under **`@goclubhouse`**, not `@clubhouse` — that org belongs to someone else.

## Why it exists

Settling a fraction of a cent on-chain per chess move costs more gas than the move is worth.
`batch-settlement` solves that: an agent deposits once into a payment channel, signs an off-chain
voucher per move, and the receiver redeems the accumulated vouchers in a single on-chain claim.

**A receiver runs its own facilitator when its prices are too small for a public one.** Dexter
serves `batch-settlement` on six EVM mainnets, free, but will not process a payment under 1079 base
units on Base ($0.00108) — so any per-call price below that has to be self-facilitated. The
contracts themselves are the canonical x402 CREATE2 deployments on Base; we did not write them.

> Corrected 2026-09-09: this used to say no public facilitator served the scheme on any mainnet.
> That was false — the original probe set (payai, daydreams, heurist, xpay, x402.org) simply did not
> include Dexter.

## Where this runs — read before wiring it in

**On a trusted server process, not at the edge.** It needs Redis and a signing key, and neither
belongs in a component that terminates untrusted traffic. In our deployment the Cloudflare Worker
forwards an agent's voucher inside its signed envelope and this module verifies and accounts for it
next to the state it already needs.

The facilitator service **binds loopback by default**. Widening that address exposes other agents'
channel state and invites settlement griefing; if it must cross a host boundary, put it behind mTLS
rather than changing the bind.

## What this package contains

| Export | What it is |
|---|---|
| `createChannelManager(opts)` | The manager, with settlement policy already applied. Returns `{ manager, storage, stop }` |
| `createFacilitatorService(opts)` | The minimal self-hosted facilitator: one scheme, one network, no custody, no discovery surface |
| `selectWithinCeiling(channels, ceiling, state, now, intervalMs?)` | The claim circuit breaker, as a pure function |
| `owedBy(candidate)` | Amount a channel is owed. Never negative, even when bookkeeping disagrees |
| `localAuthorizerSigner(account)` / `remoteAuthorizerSigner(config)` | The two `AuthorizerSigner` implementations. Both come back already wrapped in `claimsOnly` |
| `NETWORK`, `CONTRACTS`, `USDC` | CAIP-2 ids and the canonical Base contract addresses |
| `MIN_WITHDRAW_DELAY_SECS`, `DEFAULT_WITHDRAW_DELAY_SECS` | 900 and 3600 |

### The circuit breaker is the part worth reading

Claiming is the only step that moves money, so it is the step worth bounding. `selectWithinCeiling`
caps how much may be claimed per interval: if a bug or an attack inflates what the accounting says
agents owe, the loss is a number chosen in advance rather than whatever the accounting says.

It is deliberately a **pure function, separate from the manager wiring** — a control nobody can test
in isolation is a control nobody trusts. `test/breaker.test.mjs` exercises it directly.

Two properties that are easy to get wrong and are load-bearing here:

- Deferral is **not** rejection. A channel held back this interval is claimed in a later one, and the
  agent's signed vouchers stay valid. Nothing is forfeited.
- Channels are considered in **descending order of amount owed**, so when the ceiling binds the
  largest real debts settle first and a flood of dust channels cannot starve a genuine one.

`ceilingHit` on the decision is worth wiring to an alert. Hitting the ceiling means either real
growth — which you raise deliberately — or something wrong.

### Three keys, three roles

Conflating any two of them is a finding, not a shortcut.

| Role | Holds | Signs |
|---|---|---|
| **Authorizer** | nothing | `ClaimBatch` only |
| **Submitter** | gas | nothing off-chain; broadcasts what it is handed |
| **Receiver** | the pot | nothing in this scheme |

None of them may be the platform's general deployer key.

`AuthorizerSigner` is a two-member interface — an address and `signTypedData` — so a KMS or remote
signing service satisfies it exactly as well as a local key. Production should use one;
`localAuthorizerSigner` exists for tests and the paper environment. `remoteAuthorizerSigner` refuses
any URL that is not HTTPS or loopback, and checks the address in the response against the configured
one, so a swapped service fails loudly instead of producing claims against channels opened for
somebody else.

**The refund path is the exposure that matters.** On the claim path this key is bounded by the
contract: every claim tuple carries the payer's own EIP-712 voucher signature and the contract
tracks `totalClaimed` per channel, so the key cannot invent a debt or exceed `maxClaimableAmount`.
On the refund path it is not bounded at all — `refundWithSignature` takes **no payer signature**, so
the receiver-authorizer alone can push funds out of any channel immediately, bypassing the withdraw
delay. Funds return to each channel's payer, which sounds reassuring and is not: agents
self-register, so an attacker trivially *is* a payer.

The consequence, stated in `src/signer.ts` and repeated here because it is the single most important
line in this package: **any policy for this key must refuse `primaryType: "Refund"` outright.**

**This package enforces that itself.** `claimsOnly` in `src/signer.ts` is an allow-list wrapper —
`ClaimBatch` and nothing else — and both `localAuthorizerSigner` and `remoteAuthorizerSigner` return
signers already wrapped in it. There is no constructor option to disable it, because a flag that
allows refunds is a flag somebody sets at 2am to unstick something. The check runs *before* the
wrapped signer is touched, which is what makes it meaningful for the remote signer: a refused
request never becomes a request, so no socket opens and no bearer token leaves the process.

**Caveat worth knowing before you build on it:** `claimsOnly`, `RefundRefused`,
`ALLOWED_PRIMARY_TYPES` and `REFUSED_PRIMARY_TYPES` live in `src/signer.ts` but are **not
re-exported from the package entry point**, so you cannot `import { claimsOnly } from
'@goclubhouse/channel-manager'` today. You get the behaviour through the two signer factories; you
just cannot reach the wrapper by name from the published surface, or catch `RefundRefused` by its
class. Read `src/signer.ts` in the repo to audit it.

## What is NOT in this package

The Clubhouse's key-separation check (`keySeparationFailures`) and its claim job's
`selectRefundChannels` run on the private origin and are **not published here**.
[`docs/payment-channels.md`](../../docs/payment-channels.md) names them so you can ask about them by
name, not so you can grep for them.

Nothing here talks to The Clubhouse. It is a generic `batch-settlement` manager; the game-specific
half lives elsewhere.

## Licence

MIT
