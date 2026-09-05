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
 * What this key can and cannot do is worth being precise about. It authorises
 * claims *up to the cumulative amount an agent has already signed vouchers for*.
 * It cannot invent a debt, cannot claim more than the agent authorised, and
 * cannot touch a channel's deposit outside that bound — those limits are enforced
 * on-chain by the batch-settlement contract, not by this code. A stolen
 * authorizer key is a serious incident, but it is not a drain of every channel.
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
