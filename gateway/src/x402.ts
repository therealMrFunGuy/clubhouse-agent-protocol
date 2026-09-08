/**
 * x402 payment layer.
 *
 * Everything here is verified working on workerd as of 2026-09-05 — see the
 * Phase 0 notes in README. The gotchas encoded below are the ones that cost time
 * in the spike; do not "simplify" them without re-reading that section.
 *
 *   - Networks are CAIP-2. Base is `eip155:8453`, NOT the bare string "base".
 *   - `initialize()` must be awaited AND requires a facilitator that advertises
 *     the scheme/network for every configured route. You cannot emit a 402
 *     without one — the route check runs at startup, not at request time.
 *   - `price` is passed as an explicit { amount, asset } rather than a "$1.00"
 *     string so token decimals are never inferred on a money path. The platform
 *     has shipped decimal-inference bugs before; this is not stylistic.
 */

import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
} from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import type { Env } from './types';

/** CAIP-2 network ids. */
export const NETWORK = {
  baseMainnet: 'eip155:8453',
  baseSepolia: 'eip155:84532',
  polygonMainnet: 'eip155:137',
} as const;

/** Canonical USDC contracts, by CAIP-2 network. */
export const USDC: Record<string, string> = {
  [NETWORK.baseMainnet]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [NETWORK.baseSepolia]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  [NETWORK.polygonMainnet]: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

/**
 * The asset's EIP-712 domain, which the 402 challenge MUST carry.
 *
 * The `exact` scheme pays by signing an EIP-3009 `TransferWithAuthorization`,
 * and that signature is over a typed-data domain built from the token's own
 * `name` and `version`. A challenge without them is unpayable: the client has
 * nothing to sign against and refuses, which is exactly what happened the first
 * time a real client met this gateway —
 *
 *   "EIP-712 domain parameters (name, version) are required in payment
 *    requirements for asset 0x8335…2913"
 *
 * The gateway emitted `extra: {}` and every conforming agent would have bounced
 * off it. Nothing in the paper environment caught this, because paper mode
 * substitutes a wallet signature and never builds a real payment.
 *
 * Values are read from the contracts themselves, not assumed: Base mainnet USDC
 * reports name "USD Coin" and version "2" — NOT "USDC", which is the obvious
 * guess and would produce a signature the token rejects.
 */
export const ASSET_EIP712: Record<string, { name: string; version: string }> = {
  [NETWORK.baseMainnet]: { name: 'USD Coin', version: '2' },
  [NETWORK.baseSepolia]: { name: 'USDC', version: '2' },
  [NETWORK.polygonMainnet]: { name: 'USD Coin', version: '2' },
};

/**
 * Public facilitators verified to advertise `exact` on Base mainnet
 * (probed 2026-09-05). Listed in preference order — the gateway treats the
 * facilitator as swappable, so an outage at one is a config change, not an
 * incident.
 *
 * NOTE: `batch-settlement` is NOT offered by any of these on mainnet. Per-move
 * metering is therefore deferred; see README "Pricing".
 */
export const MAINNET_FACILITATORS = [
  'https://facilitator.payai.network',
  'https://facilitator.daydreams.systems',
  'https://facilitator.heurist.xyz',
  'https://facilitator.xpay.sh',
] as const;

/**
 * Free, credential-less, and supports batch-settlement + upto on Base Sepolia.
 * This is the paper environment used by the bug bounty.
 */
export const TESTNET_FACILITATOR = 'https://x402.org/facilitator';

/** USDC base units (6dp) from a decimal string. Never uses floating point. */
export function usdc(amount: string): string {
  const [whole, frac = ''] = amount.split('.');
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`Invalid USDC amount: ${amount}`);
  }
  return `${whole}${frac.padEnd(6, '0').slice(0, 6)}`.replace(/^0+(?=\d)/, '');
}

/**
 * Priced routes. Reads and in-game moves are absent by design: discovery is
 * free, and the entry fee is the single money event per game.
 */
export function buildRoutes(env: Env) {
  const network = env.X402_NETWORK ?? NETWORK.baseMainnet;
  const asset = USDC[network];
  if (!asset) throw new Error(`No USDC asset configured for network ${network}`);

  const payTo = env.AGENT_POT_ADDRESS;
  if (!payTo) throw new Error('AGENT_POT_ADDRESS is not configured');

  const domain = ASSET_EIP712[network];
  if (!domain) throw new Error(`No EIP-712 domain configured for ${network}`);

  const option = (price: string) => ({
    scheme: 'exact',
    network,
    payTo,
    price: { amount: usdc(price), asset },
    maxTimeoutSeconds: 120,
    // Carried into the challenge's `extra`. Without this the client cannot
    // build the EIP-3009 signature and declines to pay at all.
    extra: domain,
  });

  return {
    'POST /v1/matchmaking/queue': {
      resource: 'https://agents.goclubhouse.io/v1/matchmaking/queue',
      description: 'Ranked seat on the Clubhouse agent ladder',
      mimeType: 'application/json',
      accepts: [option(env.PRICE_RANKED_SEAT ?? '1.00')],
    },
    'POST /v1/tournaments/*/join': {
      resource: 'https://agents.goclubhouse.io/v1/tournaments/join',
      description: 'Buy-in to a Clubhouse agent tournament',
      mimeType: 'application/json',
      // MUST equal the origin's AGENT_PRICE_TOURNAMENT_BASE. That check is an
      // equality, not a floor, so a disagreement refuses every real payment —
      // the correct failure for a price that has drifted on a money route.
      accepts: [option(env.PRICE_TOURNAMENT_ENTRY ?? '5.00')],
    },
  };
}

let cached: { server: x402HTTPResourceServer; ready: Promise<void> } | null = null;

/** Build (once per isolate) and initialize the x402 resource server. */
export async function getPaymentServer(env: Env): Promise<x402HTTPResourceServer> {
  if (!cached) {
    const url = env.X402_FACILITATOR_URL ?? MAINNET_FACILITATORS[0];
    const resourceServer = new x402ResourceServer(
      new HTTPFacilitatorClient({ url, timeoutMs: 20_000 }),
    );
    // Empty config registers the eip155:* wildcard, covering Base and Polygon.
    registerExactEvmScheme(resourceServer, {});

    const server = new x402HTTPResourceServer(resourceServer, buildRoutes(env) as never);
    cached = { server, ready: server.initialize() };
  }
  await cached.ready;
  return cached.server;
}

/** Minimal HTTPAdapter over the Workers `Request`. */
export function adapterFor(request: Request) {
  const url = new URL(request.url);
  return {
    getHeader: (name: string) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get('accept') ?? '',
    getUserAgent: () => request.headers.get('user-agent') ?? '',
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
    getBody: async () => undefined,
  };
}

/** The payment header, under both the v2 and v1 names. */
export function paymentHeaderFrom(request: Request): string | undefined {
  return (
    request.headers.get('PAYMENT-SIGNATURE') ??
    request.headers.get('X-PAYMENT') ??
    undefined
  );
}

/**
 * The only protocol version this gateway will price a seat under.
 *
 * v1's requirement matching is materially weaker and must never run here — see
 * `declaredX402Version`.
 */
export const SUPPORTED_X402_VERSION = 2;

/**
 * The x402 version a CLIENT declared, or null when no payment was presented.
 *
 * ## Why this is read separately, before the library sees it
 *
 * The library decodes the payment header with a bare `JSON.parse` of the
 * base64 body — there is no schema — so every field in it, `x402Version`
 * included, is attacker-controlled input rather than negotiated protocol state.
 *
 * That matters because `findMatchingRequirements` switches on this number.
 * Under v2 it deep-equals the client's echoed `accepted` terms against the
 * server's own requirement, so the terms cannot be forged. Under **v1 it
 * compares `scheme` and `network` and nothing else** — leaving `amount` and
 * `asset` free. Verification still charges the real price, so the money is
 * right; but the *declared* figure downstream is not, and downstream is where
 * this platform sizes the pot.
 *
 * Refusing the version outright is the narrow fix. It is deliberately checked
 * BEFORE `processHTTPRequest`, because that call is what runs the weak match.
 */
export function declaredX402Version(header: string | undefined): number | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(decodePaymentHeader(header));
    const version = (decoded as Record<string, unknown>)?.x402Version;
    // A missing or non-numeric version is not "probably fine": it is a payload
    // whose shape we do not recognise, presented to a paid route.
    return typeof version === 'number' ? version : NaN;
  } catch {
    // Undecodable, so the version is unknowable — and an unknowable version
    // cannot be confirmed to be v2. Refusing is the only safe answer: letting
    // it through means the library may still decode it and take the v1 branch.
    return NaN;
  }
}

/**
 * Decode the payment header EXACTLY as @x402/core does.
 *
 * Deliberately mirrors its `safeBase64Decode` — standard base64 (the library's
 * own regex is `/^[A-Za-z0-9+/]*={0,2}$/`, so no base64url), decoded through
 * TextDecoder rather than treating `atob`'s binary string as text.
 *
 * The equivalence is the point. A guard that parses its input differently from
 * the code it guards has a gap between the two readings, and that gap is where
 * the thing being guarded against lives. Here it would be concrete: plain
 * `atob` mangles any multi-byte UTF-8 in the payload, so a payload this
 * function failed to read but the library read fine would be refused as a false
 * positive — or, worse under a looser guard, waved through unchecked.
 */
function decodePaymentHeader(header: string): string {
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
