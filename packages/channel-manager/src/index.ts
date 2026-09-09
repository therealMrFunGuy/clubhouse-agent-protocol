/**
 * Batch-settlement channel manager for The Clubhouse agent ladder.
 *
 * ## Why this exists
 *
 * Charging a fraction of a cent on-chain per chess move would cost more in gas
 * than the move is worth. x402's `batch-settlement` scheme solves that: an agent
 * deposits once into a payment channel, signs an off-chain voucher per move, and
 * the receiver redeems the accumulated vouchers in a single claim.
 *
 * We run our own facilitator because per-move prices fall below what a public
 * one will process (Dexter's Base floor is 1079 base units; a move costs 500),
 * not because none exists. The contracts are the canonical x402 deployments on
 * Base mainnet — we did not write them and we do not custody funds; the
 * withdraw path is enforced on-chain.
 *
 * ## Where this runs
 *
 * On the **private origin**, not the edge Worker. It needs persistent state and
 * a signing key, and neither belongs in a component that terminates untrusted
 * traffic. The Worker forwards a voucher inside its signed envelope; this module
 * verifies and accounts for it next to the Redis and chain access it already
 * needs.
 *
 * ## What an agent risks
 *
 * Their deposit, and only up to what they have signed vouchers for. They can
 * withdraw at any time subject to `withdrawDelay` — a window that exists so
 * vouchers already signed can be claimed before the balance leaves, and which is
 * enforced by the contract rather than by us.
 */

import {
  BatchSettlementChannelManager,
  type Channel,
  type ClaimResult,
} from '@x402/evm/batch-settlement/server';
import { RedisChannelStorage } from '@x402/evm/batch-settlement/server/redis-storage';
import type { AuthorizerSigner } from './signer.js';
import { selectWithinCeiling, type BreakerState } from './breaker.js';

export {
  localAuthorizerSigner,
  remoteAuthorizerSigner,
  // Re-exported from the root because the docs invite researchers to check this
  // control, and a deep import into ./signer.js is not something a reader of
  // the README would guess.
  claimsOnly,
  RefundRefused,
  ALLOWED_PRIMARY_TYPES,
  REFUSED_PRIMARY_TYPES,
  type AuthorizerSigner,
} from './signer.js';
export { selectWithinCeiling, owedBy, type ClaimCandidate, type BreakerState } from './breaker.js';
export { createFacilitatorService, type FacilitatorServiceOptions } from './facilitator.js';

/** CAIP-2 networks where the batch-settlement contracts are deployed. */
export const NETWORK = {
  baseMainnet: 'eip155:8453',
  baseSepolia: 'eip155:84532',
} as const;

/**
 * Canonical x402 batch-settlement contracts. Deterministic CREATE2 addresses,
 * identical across chains. Verified deployed on Base mainnet 2026-09-05.
 * NOT deployed on Polygon — do not enable the scheme there without re-checking.
 */
export const CONTRACTS = {
  batchSettlement: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003',
  erc3009DepositCollector: '0x4020806089470a89826cB9fB1f4059150b550004',
  permit2DepositCollector: '0x4020425FAf3B746C082C2f942b4E5159887B0005',
} as const;

export const USDC: Record<string, `0x${string}`> = {
  [NETWORK.baseMainnet]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [NETWORK.baseSepolia]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

/**
 * The contract's own floor is 15 minutes. We hold agents to a longer default:
 * long enough that a claim cycle cannot be outrun by a withdrawal, short enough
 * that an agent's money is not meaningfully locked up.
 */
export const MIN_WITHDRAW_DELAY_SECS = 900;
export const DEFAULT_WITHDRAW_DELAY_SECS = 3600;

export interface ChannelManagerOptions {
  /** Redis client. Shape matches node-redis; the platform already runs one. */
  redis: ConstructorParameters<typeof RedisChannelStorage>[0]['client'];
  /** Signs claims. Use a remote signer in production — never the deployer key. */
  signer: AuthorizerSigner;
  /** Where claimed funds land. The agent pot, separate from the human treasury. */
  receiver: `0x${string}`;
  /** Our self-hosted batch-settlement facilitator. */
  facilitator: ConstructorParameters<typeof BatchSettlementChannelManager>[0]['facilitator'];
  scheme: ConstructorParameters<typeof BatchSettlementChannelManager>[0]['scheme'];
  /** CAIP-2, e.g. `eip155:8453`. Bare names like "base" are not valid. */
  network?: `${string}:${string}`;
  withdrawDelaySecs?: number;
  /** Ceiling on value claimable per interval. The circuit breaker. */
  maxClaimPerIntervalBase?: bigint;
  /** Called when the ceiling deferred channels. Wire this to an alert. */
  onCeilingHit?: (deferredCount: number) => void;
  onError?: (error: unknown) => void;
}

export interface ChannelManagerHandle {
  manager: BatchSettlementChannelManager;
  storage: RedisChannelStorage;
  /** Stop auto-settlement. Call on shutdown so a deploy cannot orphan a claim. */
  stop: () => void;
}

/**
 * Build the channel manager with settlement policy already applied.
 *
 * The defaults are deliberately conservative. Claims are the only step that
 * moves money, so they are batched, bounded, and observable rather than
 * eager.
 */
export function createChannelManager(opts: ChannelManagerOptions): ChannelManagerHandle {
  const network = opts.network ?? NETWORK.baseMainnet;

  const token = USDC[network];
  if (!token) {
    throw new Error(
      `No USDC address configured for ${network}. ` +
        'Batch-settlement contracts are only deployed on Base — verify before adding a chain.',
    );
  }

  const withdrawDelay = opts.withdrawDelaySecs ?? DEFAULT_WITHDRAW_DELAY_SECS;
  if (withdrawDelay < MIN_WITHDRAW_DELAY_SECS) {
    // Below the contract's floor the deployment simply rejects the channel;
    // failing here gives a comprehensible error instead of an on-chain revert.
    throw new Error(
      `withdrawDelay ${withdrawDelay}s is below the contract minimum of ${MIN_WITHDRAW_DELAY_SECS}s`,
    );
  }

  const storage = new RedisChannelStorage({
    client: opts.redis,
    keyPrefix: 'cap:chan:',
  });

  const manager = new BatchSettlementChannelManager({
    scheme: opts.scheme,
    facilitator: opts.facilitator,
    receiver: opts.receiver,
    token,
    network,
  });

  // ── Settlement policy ────────────────────────────────────────────────────
  //
  // A claim is the step that actually moves money, so it is the step worth
  // bounding. `maxClaimPerIntervalBase` is the circuit breaker: if a bug or an
  // attack inflates what we believe is owed, the per-interval ceiling caps how
  // much can leave before a human notices, rather than letting one cycle drain
  // whatever the accounting says.
  let breaker: BreakerState = { claimedThisInterval: 0n, intervalStartedAt: Date.now() };

  manager.start({
    // Claim hourly rather than per-voucher — the whole point of the scheme.
    claimIntervalSecs: 3600,
    settleIntervalSecs: 3600,
    refundIntervalSecs: 900,
    maxClaimsPerBatch: 50,

    selectClaimChannels: (channels: Channel[]) => {
      const decision = selectWithinCeiling(
        channels,
        opts.maxClaimPerIntervalBase,
        breaker,
        Date.now(),
      );
      breaker = decision.state;

      if (decision.ceilingHit) {
        // Deferral is safe — vouchers stay valid and the channels are claimed
        // next interval — but it should never be silent. Hitting the ceiling
        // means either real growth (raise it deliberately) or something wrong.
        opts.onCeilingHit?.(decision.deferred.length);
      }

      return decision.selected;
    },

    onClaim: (result: ClaimResult) => {
      // Deliberately does NOT add to the breaker.
      //
      // `selectWithinCeiling` already reserved every selected channel's owed
      // amount into `claimedThisInterval` — that reservation is what bounds the
      // decision, and it has to happen at selection time because that is when
      // the decision is made. Adding the claimed total again here counted the
      // same money twice, so a ceiling of $500 actually bound at roughly $250
      // and deferred channels that fitted underneath it. A limit that binds at
      // half its configured value is a limit whose configured value is a lie.
      //
      // The residue is that a claim which fails still holds its reservation
      // until the interval rolls. That is the conservative direction, and one
      // hour is the whole cost.
      void result;
    },

    onError: (error: unknown) => {
      // Never swallow: a silent failure here means vouchers accumulate
      // unclaimed and the shortfall only surfaces when an agent withdraws.
      if (opts.onError) opts.onError(error);
      else console.error('[channel-manager] settlement error:', error);
    },
  });

  return {
    manager,
    storage,
    /**
     * Flushes in-flight settlement before returning.
     *
     * `flush: true` is not optional politeness. This platform has already lost a
     * payout to a deploy that landed between a claim being decided and it being
     * paid; a settlement loop killed mid-cycle here would strand vouchers the
     * same way. Call this from the shutdown hook and let it finish.
     */
    stop: () => manager.stop({ flush: true }),
  };
}
