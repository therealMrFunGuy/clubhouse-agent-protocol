/**
 * Our own facilitator, reached through the signed envelope.
 *
 * ## Why this exists
 *
 * There are two payment schemes here and they had two different facilitators,
 * which is a distinction that is easy to lose:
 *
 *   - `batch-settlement` — per-move metering. Public facilitators do serve this
 *     on mainnet (corrected 2026-09-09 — Dexter, six EVM chains, free), but
 *     none will process a payment as small as a move: their floor on Base is
 *     1079 base units and a move costs 500. So we run it ourselves.
 *   - `exact` — the entry fee. Public facilitators serve this, and until now
 *     that is what the gateway used.
 *
 * The public ones disagree with each other. Probed 2026-09-08 with a real
 * permit2 payment signed by a wallet holding nothing:
 *
 *   xpay.sh      insufficient_funds     correct — parsed it and checked chain
 *   heurist.xyz  invalid_asset_address  refuses WETH outright
 *   payai        **isValid: true**      approved a payment that cannot settle
 *
 * payai was `MAINNET_FACILITATORS[0]`, this gateway's default. The same probe
 * on the USDC/EIP-3009 path has all three refusing correctly, so nothing in
 * production was ever wrong — but WETH and CRED need permit2, and they could
 * not be enabled while their validity rested on somebody else's broken check.
 *
 * ## Why it is safe to depend on ourselves
 *
 * A facilitator is a dependency, and swapping a public one for our own looks
 * like trading redundancy for control. It is not, here: the origin already has
 * to be up for a seat to be granted at all, so a facilitator living beside it
 * cannot fail independently of the thing it gates. The public facilitators were
 * never redundancy for THIS gateway — they were a second thing that had to work.
 *
 * ## The interface
 *
 * `FacilitatorClient` is three methods. This implements them over the same HMAC
 * envelope as every other origin call, which is what keeps the facilitator
 * unreachable from the internet — its own package warns that an exposed
 * facilitator is an oracle for other agents' channel state.
 */

import { forwardToOrigin } from './origin';
import type { Env, AgentIdentity } from './types';

const ANON: AgentIdentity = { wallet: null, keyId: null, tier: 'anon' };

export class OriginFacilitatorClient {
  constructor(
    private readonly env: Env,
    /** Internal chain id the origin uses, e.g. `base-mainnet`. */
    private readonly chainId: string,
  ) {}

  private async call(action: 'verify' | 'settle' | 'supported', body: unknown): Promise<any> {
    const res = await forwardToOrigin(this.env, {
      method: 'POST',
      path: `/facilitator/${action}`,
      body: { chainId: this.chainId, ...(body as object) },
      // The gateway talking to the origin, not an agent. Attributing it to a
      // payer would spend that agent's quota on our own plumbing.
      identity: ANON,
    });

    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Facilitator returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
      // Surfaced rather than swallowed. A facilitator that cannot be reached
      // must not look like a payment that failed verification: one is our
      // outage and the other is the agent's problem, and confusing them sends
      // an agent away believing its wallet is at fault.
      throw new Error(
        `Facilitator ${action} failed (HTTP ${res.status})${
          parsed?.missing ? `: missing ${parsed.missing.join(', ')}` : ''
        }`,
      );
    }
    return parsed;
  }

  async verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<any> {
    return this.call('verify', { paymentPayload, paymentRequirements });
  }

  async settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<any> {
    return this.call('settle', { paymentPayload, paymentRequirements });
  }

  async getSupported(): Promise<any> {
    // Called during initialize(), which validates that every priced route has a
    // facilitator advertising its scheme and network. A wrong answer here is a
    // gateway that cannot emit a 402 at all, so it is worth the round trip.
    return this.call('supported', {});
  }
}
