/**
 * The private hop.
 *
 * The origin (`goclubhouse.io/api/internal/agent/v1/*`) is not routable from the
 * internet. It accepts a request only when it arrives from a Cloudflare address
 * carrying a valid signature over (timestamp, nonce, method, path, body).
 *
 * Two properties matter and are easy to lose:
 *
 *  1. The wallet is placed in the signed envelope by the GATEWAY, from a payment
 *     the gateway verified. It is never read from a client header — otherwise
 *     any caller could assert any identity.
 *  2. `x-chain-id` is derived from the settled payment's network, never from
 *     agent input. Getting this wrong pays out on one chain and records the
 *     result against another; the platform has shipped that bug before.
 */

import type { Env, AgentIdentity } from './types';

const SIGNED_HEADER = 'x-cap-signature';
const TS_HEADER = 'x-cap-timestamp';
const NONCE_HEADER = 'x-cap-nonce';

/** Maximum accepted clock skew. The origin enforces the same bound. */
export const MAX_SKEW_MS = 30_000;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/**
 * Canonical string to sign. Order and separator are part of the contract — the
 * origin recomputes this exactly. Changing it is a breaking change on both sides.
 */
export function canonicalString(parts: {
  timestamp: string;
  nonce: string;
  method: string;
  /** Full path INCLUDING query string — both are security-relevant. */
  path: string;
  bodyHash: string;
  wallet: string;
  /**
   * Internal chain id, derived from the SETTLED payment.
   *
   * Signed rather than merely forwarded. An unsigned chain id is the
   * split-brain payout the platform has already shipped once — settle on one
   * chain, record the result against another — and the origin's nginx
   * allowlist admits every Cloudflare egress range, so "only we can reach it"
   * is not an authentication story.
   */
  chainId: string;
  /**
   * sha256 of the payment receipt header, or '' when the call was not paid for.
   *
   * The receipt rides in `x-cap-payment` rather than the body so that paid GETs
   * work too. Hashing it into the signed string is what makes that header
   * trustworthy — otherwise a caller could mint a receipt for a payment that
   * never happened, and since the entry fee is the only money event at launch,
   * that one header is the entire paywall.
   */
  paymentHash: string;
}): string {
  return [
    parts.timestamp,
    parts.nonce,
    parts.method,
    parts.path,
    parts.bodyHash,
    parts.wallet,
    parts.chainId,
    parts.paymentHash,
  ].join('\n');
}

/**
 * What the gateway asserts about the payment that bought a request.
 * Derived from a VERIFIED payment; never from anything the agent sent.
 */
export interface PaymentReceipt {
  nonce: string;
  scheme: string;
  network: string;
  asset: string;
  /** Exact base units as a decimal string — never a float. */
  amount: string;
  resource: string;
}

export async function sha256Hex(body: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
}

/** Forward a request to the private origin under a signed envelope. */
export async function forwardToOrigin(
  env: Env,
  opts: {
    method: string;
    path: string;
    body?: unknown;
    /** Exact request bytes to forward, when the caller already has them. */
    rawBody?: string;
    identity: AgentIdentity;
    /** CAIP-2 network of the SETTLED payment, when this call was paid for. */
    settledNetwork?: string;
    /** The verified payment, when this call was paid for. */
    payment?: PaymentReceipt;
    /**
     * Replay key for the origin's nonce store.
     *
     * Supplied for wallet-signature calls so the AGENT's own nonce becomes the
     * replay guard — a captured signed request is then rejected downstream
     * instead of being re-forwarded under a fresh gateway nonce. Omitted for
     * everything else, where a random value is correct.
     */
    nonce?: string;
  },
): Promise<Response> {
  // Prefer the caller's exact bytes. When an agent signed a body hash,
  // re-serialising here would mean the bytes it signed and the bytes the origin
  // executes are not the same string — each hash internally consistent, neither
  // covering the other.
  const body = opts.rawBody ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
  const timestamp = String(Date.now());
  const nonce = opts.nonce ?? crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const wallet = opts.identity.wallet ?? '';

  // Empty string when the call was not paid for. Still signed, so a caller
  // cannot add a chain id to an unpaid request.
  const chainId = opts.settledNetwork ? chainIdForNetwork(opts.settledNetwork) : '';

  // Serialise ONCE and sign that exact string. Hashing a re-serialisation would
  // reintroduce key-order sensitivity between the two sides.
  const paymentJson = opts.payment ? JSON.stringify(opts.payment) : '';
  const paymentHash = paymentJson ? await sha256Hex(paymentJson) : '';

  const signature = await hmac(
    env.ORIGIN_HMAC_SECRET,
    canonicalString({
      timestamp,
      nonce,
      method: opts.method,
      path: opts.path,
      bodyHash,
      wallet,
      chainId,
      paymentHash,
    }),
  );

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [TS_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNED_HEADER]: signature,
    // Identity, asserted by the gateway on the strength of a verified payment.
    'x-cap-wallet': wallet,
    'x-cap-tier': opts.identity.tier,
  };

  // Derived from settlement, never from the agent, and covered by the signature
  // above so the origin can trust it rather than merely receive it.
  if (chainId) headers['x-chain-id'] = chainId;
  // Same rule: forwarded verbatim, and only trustworthy because its hash is in
  // the signed string. The origin re-hashes what it receives.
  if (paymentJson) headers['x-cap-payment'] = paymentJson;

  return fetch(`${env.ORIGIN_BASE_URL}/api/internal/agent/v1${opts.path}`, {
    method: opts.method,
    headers,
    body: body || undefined,
  });
}

/** Map a CAIP-2 network to the platform's internal chain id (lib/chains.ts). */
export function chainIdForNetwork(network: string): string {
  switch (network) {
    case 'eip155:8453':
      return 'base-mainnet';
    case 'eip155:137':
      return 'polygon';
    case 'eip155:84532':
      return 'base-sepolia';
    default:
      throw new Error(`Unmapped settlement network: ${network}`);
  }
}
