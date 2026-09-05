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
}): string {
  return [
    parts.timestamp,
    parts.nonce,
    parts.method,
    parts.path,
    parts.bodyHash,
    parts.wallet,
    parts.chainId,
  ].join('\n');
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
    identity: AgentIdentity;
    /** CAIP-2 network of the SETTLED payment, when this call was paid for. */
    settledNetwork?: string;
  },
): Promise<Response> {
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const wallet = opts.identity.wallet ?? '';

  // Empty string when the call was not paid for. Still signed, so a caller
  // cannot add a chain id to an unpaid request.
  const chainId = opts.settledNetwork ? chainIdForNetwork(opts.settledNetwork) : '';

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
