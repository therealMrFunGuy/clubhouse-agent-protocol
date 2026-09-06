/**
 * Wallet-signature authentication, for the calls that are free.
 *
 * x402 gives us identity for free: a verified payment is signed by the payer,
 * so paying proves address control. That covers joining a game. It does not
 * cover playing one — moves are free, and an agent that had to pay per move
 * would be metered on the one action it cannot avoid taking.
 *
 * So free-but-identified routes use the same primitive without the money: the
 * agent signs a challenge naming exactly what it is about to do, and control of
 * the address is proven by the signature rather than by a bearer token. Nothing
 * is stored, nothing expires, and there is no token to leak.
 *
 * The challenge binds method, path and body. Signing a bare nonce would let a
 * captured signature be replayed against a different endpoint — sign "prove I
 * am 0xabc" once and an attacker resigns your game with it.
 */

import { verifyMessage } from 'viem';

export const ADDRESS_HEADER = 'x-cap-agent-address';
export const TIMESTAMP_HEADER = 'x-cap-agent-timestamp';
export const NONCE_HEADER = 'x-cap-agent-nonce';
export const SIGNATURE_HEADER = 'x-cap-agent-signature';

/** Matches the origin's envelope window. */
export const MAX_SKEW_MS = 30_000;

export type AuthFailure =
  | 'missing'
  | 'bad_address'
  | 'bad_timestamp'
  | 'stale'
  | 'bad_signature';

export interface AuthResult {
  ok: boolean;
  address?: string;
  /** Namespaced nonce to forward as the envelope nonce; see below. */
  envelopeNonce?: string;
  failure?: AuthFailure;
}

/**
 * The exact string an agent signs.
 *
 * Versioned on the first line so the format can change without old signatures
 * silently meaning something new under a different interpretation.
 */
export function challengeString(parts: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    'clubhouse-agent-v1',
    parts.timestamp,
    parts.nonce,
    parts.method.toUpperCase(),
    parts.path,
    parts.bodyHash,
  ].join('\n');
}

async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify an agent's signature over this request.
 *
 * `rawBody` must be the bytes actually forwarded, so the signature covers what
 * the origin will execute rather than a re-serialisation of it.
 */
export async function verifyAgentSignature(
  request: Request,
  path: string,
  rawBody: string,
): Promise<AuthResult> {
  const address = request.headers.get(ADDRESS_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const nonce = request.headers.get(NONCE_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);

  if (!address || !timestamp || !nonce || !signature) {
    return { ok: false, failure: 'missing' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, failure: 'bad_address' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, failure: 'bad_timestamp' };
  // Bounded in both directions. A far-future timestamp would otherwise let a
  // captured request be held and replayed after its nonce expired downstream.
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { ok: false, failure: 'stale' };

  const message = challengeString({
    timestamp,
    nonce,
    method: request.method,
    path,
    bodyHash: await sha256Hex(rawBody),
  });

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    // A malformed signature throws rather than returning false.
    valid = false;
  }
  if (!valid) return { ok: false, failure: 'bad_signature' };

  return {
    ok: true,
    address,
    // Namespaced by address before it becomes the origin's replay key. The
    // agent chooses this value, and an unnamespaced one would let anybody
    // pre-claim a nonce another agent was about to use and have their request
    // rejected as a replay.
    envelopeNonce: `${address.toLowerCase()}:${nonce}`,
  };
}
