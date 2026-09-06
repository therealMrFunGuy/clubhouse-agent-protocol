/**
 * The authorizer signer.
 *
 * This key authorises claims against agents' payment channels. It is the most
 * sensitive thing in the batch-settlement path, so two rules hold:
 *
 *  1. **It is dedicated.** It must never be the platform's general deployer key.
 *     That key already signs for every chain from inside the web process; giving
 *     it a second job in a component that faces unbounded agent traffic widens a
 *     blast radius that is already too wide.
 *
 *  2. **It never needs to be in this process.** `AuthorizerSigner` is a
 *     two-member interface — an address and `signTypedData`. A remote signer or
 *     KMS satisfies it exactly as well as a local key, so production should use
 *     one. The local implementation exists for the paper environment and tests.
 *
 * ## Blast radius — corrected after audit
 *
 * An earlier version of this comment claimed a stolen key "is not a drain of
 * every channel". **That was wrong, and it was wrong in the dangerous
 * direction**, so it is worth stating precisely what is and is not true.
 *
 * On the CLAIM path the old claim holds. `claimWithSignature` carries the
 * payer's own EIP-712 voucher signature inside each claim tuple and the contract
 * tracks `totalClaimed` per channel, so this key cannot invent a debt, cannot
 * exceed `maxClaimableAmount`, and gains nothing from replaying a claim.
 *
 * **But the same key also signs refunds, and `refundWithSignature` takes no
 * payer signature at all.** The receiver-authorizer alone can push funds out of
 * any channel, immediately, bypassing the withdraw delay. So a stolen key can
 * destroy every unclaimed receivable and empty every channel. Funds return to
 * each channel's payer rather than to the attacker — but agents self-register,
 * so an attacker trivially IS a payer: run up an unbounded tab across channels,
 * then refund them. That is direct, self-directed profit.
 *
 * The practical consequence: a KMS policy for this key MUST refuse
 * `primaryType: "Refund"` outright. That single restriction is worth more than
 * everything else in this file, because it is what makes the claim-path bound
 * the real bound rather than a partial one.
 */

import type { TypedData } from 'viem';

export interface AuthorizerSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Adapt a viem account into an `AuthorizerSigner`.
 *
 * For the paper environment and local development. In production prefer
 * {@link remoteAuthorizerSigner} so the key stays outside this process.
 */
export function localAuthorizerSigner(account: {
  address: `0x${string}`;
  signTypedData: (args: never) => Promise<`0x${string}`>;
}): AuthorizerSigner {
  return {
    address: account.address,
    signTypedData: (params) => account.signTypedData(params as never),
  };
}

export interface RemoteSignerConfig {
  /** Signing service endpoint. Must be HTTPS or loopback. */
  url: string;
  /** The address the service signs for. Verified against its response. */
  address: `0x${string}`;
  /** Bearer credential for the signing service. */
  token: string;
  timeoutMs?: number;
}

/**
 * An `AuthorizerSigner` backed by an external signing service.
 *
 * The signing service is expected to enforce its own policy — rate, amount
 * ceilings, an audit trail — so that compromising this process is not the same
 * as compromising the key.
 */
export function remoteAuthorizerSigner(config: RemoteSignerConfig): AuthorizerSigner {
  if (!/^https:\/\//.test(config.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.url)) {
    throw new Error(`Remote signer must use HTTPS (or loopback), got: ${config.url}`);
  }

  return {
    address: config.address,
    async signTypedData(params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
      try {
        const res = await fetch(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ address: config.address, ...params }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Never echo the response body — a signing service's errors can carry
          // key material or policy detail that does not belong in our logs.
          throw new Error(`Remote signer refused the request (HTTP ${res.status})`);
        }

        const body = (await res.json()) as { signature?: string; address?: string };

        if (!body.signature || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
          throw new Error('Remote signer returned no usable signature');
        }

        // Guard against a misconfigured or swapped service signing with a
        // different key than the one our channels were opened against.
        if (body.address && body.address.toLowerCase() !== config.address.toLowerCase()) {
          throw new Error('Remote signer returned a signature from an unexpected address');
        }

        return body.signature as `0x${string}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
