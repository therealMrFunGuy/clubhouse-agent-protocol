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
 *
 * ## The refusal is in this file, not only in our deployment
 *
 * It used to be described here and implemented somewhere else. Our public
 * write-ups state, as fact, that the authorizer "is refused the ability to sign
 * a refund — not by policy, but by code that never reaches the key". That was
 * true of the private platform repo and false of the package you are reading,
 * which is the one anybody can actually install and audit. A claim a researcher
 * can neither see nor run is not a control; it is marketing.
 *
 * So {@link claimsOnly} lives here now, and BOTH signers below are wrapped in
 * it before they are returned. There is no constructor option to turn it off —
 * a flag to allow refunds is a flag somebody sets at 2am to unstick something,
 * and the whole point is that no such lever exists.
 */

import type { TypedData } from 'viem';

/** The only EIP-712 message an authorizer built here will ever sign. */
export const ALLOWED_PRIMARY_TYPES: ReadonlySet<string> = new Set(['ClaimBatch']);

/** Refused unconditionally. See the header — this is the whole control. */
export const REFUSED_PRIMARY_TYPES: ReadonlySet<string> = new Set(['Refund']);

export interface AuthorizerSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/** Thrown when something asks the authorizer for the one signature it must never give. */
export class RefundRefused extends Error {
  constructor(primaryType: string) {
    super(
      `The channel authorizer refuses to sign "${primaryType}". ` +
        'refundWithSignature carries no payer signature, so a key that can sign it ' +
        'can empty every channel. Agents withdraw through the contract instead.',
    );
    this.name = 'RefundRefused';
  }
}

/**
 * Wrap a signer so it can only ever sign a claim.
 *
 * An allow-list, not a deny-list. A message type the contract gains later must
 * be refused until somebody deliberately allows it, rather than signed because
 * nobody thought to add it to a list of dangerous ones.
 *
 * The check runs before the wrapped signer is touched at all, which is what
 * makes it meaningful for {@link remoteAuthorizerSigner}: a refused request
 * never becomes a request. No socket is opened, no bearer token leaves the
 * process, and nothing reaches whatever is holding the key.
 */
export function claimsOnly(inner: AuthorizerSigner): AuthorizerSigner {
  return {
    address: inner.address,
    async signTypedData(params) {
      if (REFUSED_PRIMARY_TYPES.has(params.primaryType)) {
        throw new RefundRefused(params.primaryType);
      }
      if (!ALLOWED_PRIMARY_TYPES.has(params.primaryType)) {
        throw new Error(
          `The channel authorizer will not sign the unrecognised type "${params.primaryType}". ` +
            `Allowed: ${[...ALLOWED_PRIMARY_TYPES].join(', ')}.`,
        );
      }
      return inner.signTypedData(params);
    },
  };
}

/**
 * Adapt a viem account into an `AuthorizerSigner`.
 *
 * For the paper environment and local development. In production prefer
 * {@link remoteAuthorizerSigner} so the key stays outside this process.
 *
 * Wrapped in {@link claimsOnly}: this is the variant that holds the raw key in
 * process, so it is the one where an unguarded `Refund` would be signed
 * instantly and irreversibly.
 */
export function localAuthorizerSigner(account: {
  address: `0x${string}`;
  signTypedData: (args: never) => Promise<`0x${string}`>;
}): AuthorizerSigner {
  return claimsOnly({
    address: account.address,
    signTypedData: (params) => account.signTypedData(params as never),
  });
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
 * EIP-712 uint fields arrive as `bigint` — `signClaimBatch` builds
 * `maxClaimableAmount` and `totalClaimed` with `BigInt()` — and `JSON.stringify`
 * throws outright on one ("Do not know how to serialize a BigInt"), which meant
 * this signer failed before it ever opened a socket.
 *
 * Decimal strings are the right wire form: JSON has no integer type wide enough
 * for a uint128, and viem accepts a decimal string, a number and a bigint
 * interchangeably, producing a byte-identical signature for all three.
 */
function bigintsAsDecimalStrings(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * An `AuthorizerSigner` backed by an external signing service.
 *
 * The signing service is expected to enforce its own policy — rate, amount
 * ceilings, an audit trail, and above all a pinned EIP-712 domain — so that
 * compromising this process is not the same as compromising the key. Note what
 * that implies about the request below: `domain` and `types` are sent by a
 * caller, so a signing service that trusts them has delegated the choice of
 * what the signature MEANS to the process it is defending against. It should
 * pin both and treat this body as a request, not an instruction.
 *
 * Wrapped in {@link claimsOnly}, so a refused type never becomes an HTTP
 * request.
 */
export function remoteAuthorizerSigner(config: RemoteSignerConfig): AuthorizerSigner {
  if (!/^https:\/\//.test(config.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.url)) {
    throw new Error(`Remote signer must use HTTPS (or loopback), got: ${config.url}`);
  }

  return claimsOnly({
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
          body: JSON.stringify({ address: config.address, ...params }, bigintsAsDecimalStrings),
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
  });
}
