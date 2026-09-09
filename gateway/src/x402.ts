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
 * Everything an agent may pay with, per network.
 *
 * x402 lets a 402 advertise several `accepts` and the client picks one, which
 * is exactly the shape this needs: the agent chooses its token, the facilitator
 * settles in it, and the settled asset decides which queue the entry joins.
 * Pots never mix assets, so choosing the token IS choosing the opponent pool.
 *
 * ## Two of these need an on-chain approval first
 *
 * `exact` authorises a transfer one of two ways, and which applies is a
 * property of the token. Verified on Base mainnet by calling
 * `authorizationState(address,bytes32)` on each contract, 2026-09-08:
 *
 *   USDC  EIP-3009 present  → a signature is enough
 *   WETH  absent            → Permit2
 *   CRED  absent (reverts)  → Permit2
 *
 * Permit2 works with any ERC-20, but the payer must `approve(Permit2)` once,
 * on-chain, per token. For a machine that expects to pay by signature alone
 * that is a real barrier, which is why USDC is listed first and stays the
 * cheapest way in.
 *
 * NATIVE ETH IS NOT HERE AND CANNOT BE. `exact` signs an ERC-20 authorisation;
 * native ETH is not an ERC-20 and has no such function. "ETH" means WETH.
 */
export interface PayableAsset {
  symbol: string;
  address: string;
  decimals: number;
  /** EIP-712 domain the token actually reports. Wrong values are unsignable. */
  domain: { name: string; version: string };
  /** Decimal string, e.g. "0.5". */
  seatPrice: string;
  tournamentPrice: string;
  /** Permit2 needs a one-time on-chain approval; EIP-3009 does not. */
  needsApproval: boolean;
  /**
   * Whether a 402 actually offers this asset.
   *
   * All three are ON. This comment previously said the permit2 assets were off
   * "and this is the honest part" long after they were enabled, which is worse
   * than saying nothing: it is the kind of stale reassurance somebody reads at
   * 2am instead of checking.
   *
   * What made enabling them safe was not the flag but the check underneath it.
   * The reference `exact` scheme verifies a permit2 SIGNATURE and never asks
   * whether the payer can pay — our own facilitator returned isValid:true for a
   * WETH payment from an empty wallet, exactly as payai did, because both run
   * the same library. `checkPermit2Funds` on the origin closes that: balance AND
   * the one-time Permit2 approval, refusing rather than guessing when the chain
   * cannot be read.
   *
   * The flag remains because turning an asset off should stay a one-line change.
   */
  enabled: boolean;
}

export const PAYABLE_ASSETS: Record<string, PayableAsset[]> = {
  [NETWORK.baseMainnet]: [
    {
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      domain: { name: 'USD Coin', version: '2' },
      seatPrice: '0.50',
      tournamentPrice: '5.00',
      needsApproval: false,
      enabled: true,
    },
    {
      symbol: 'WETH',
      address: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      domain: { name: 'Wrapped Ether', version: '1' },
      seatPrice: '0.00001',
      tournamentPrice: '0.0001',
      needsApproval: true,
      enabled: true,
    },
    {
      symbol: 'CRED',
      address: '0xFD1c03e25D061B0A810F129fb0C479f0A56942C6',
      decimals: 18,
      // CRED's `name()` returns empty on Base, so this is ours to choose. Safe
      // for the same reason as WETH's version below.
      domain: { name: 'CRED', version: '1' },
      seatPrice: '10',
      tournamentPrice: '100',
      needsApproval: true,
      enabled: true,
    },
  ],
  [NETWORK.polygonMainnet]: [
    {
      symbol: 'USDC',
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      domain: { name: 'USD Coin', version: '2' },
      seatPrice: '0.50',
      tournamentPrice: '5.00',
      needsApproval: false,
      enabled: true,
    },
  ],
  [NETWORK.baseSepolia]: [
    {
      symbol: 'USDC',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      domain: { name: 'USDC', version: '2' },
      seatPrice: '0.50',
      tournamentPrice: '5.00',
      needsApproval: false,
      enabled: true,
    },
  ],
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
 * NOTE: none of these offers `batch-settlement` on mainnet, which is why we run
 * our own facilitator for per-move metering — see docs/payment-channels.md.
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

/**
 * Base units from a decimal string, at the asset's own precision.
 *
 * Never floating point. `Math.round(Number(x) * 10 ** d)` is the obvious version
 * and it is how a decimals bug reaches production; at 18 decimals it is not even
 * close, because 10^18 exceeds the safe integer range outright.
 *
 * The decimals are a PARAMETER because they are a property of the token. This
 * was previously hardcoded to 6, which is right for USDC and wrong by a factor
 * of a trillion for WETH and CRED.
 */
export function baseUnits(amount: string, decimals: number): string {
  const [whole, frac = ''] = amount.split('.');
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (frac.length > decimals) {
    // Silently truncating would under-price the route by whatever was dropped.
    throw new Error(`${amount} has more than ${decimals} decimal places`);
  }
  return `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
}

/** USDC (6dp), kept for callers that mean USDC specifically. */
export function usdc(amount: string): string {
  return baseUnits(amount, 6);
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

  const payable = (PAYABLE_ASSETS[network] ?? []).filter((a) => a.enabled);
  if (!payable.length) throw new Error(`No payable assets enabled for ${network}`);

  /**
   * One `accepts` entry per asset. The client picks; the settled asset decides
   * which queue the entry joins, because pots never mix assets.
   *
   * `extra` carries the token's own EIP-712 domain, which the challenge MUST
   * have — a client with the wrong name or version produces a signature the
   * token rejects, and this gateway has already shipped a 402 that no real
   * client could pay by omitting it entirely.
   */
  const options = (pick: (a: PayableAsset) => string) =>
    payable.map((a) => ({
      scheme: 'exact',
      network,
      payTo,
      price: { amount: baseUnits(pick(a), a.decimals), asset: a.address },
      maxTimeoutSeconds: 120,

      // ALWAYS present, even for permit2.
      //
      // For EIP-3009 this is load-bearing and must be exact: the signature is
      // over the token's own domain, and Base USDC reports "USD Coin"/"2" —
      // "USDC", the obvious guess, produces a signature the token rejects.
      //
      // For permit2 it is a client-side formality. The signature is over
      // PERMIT2's domain, not the token's, and WETH has no `version()` and CRED
      // no `name()` to read. But omitting it makes the client refuse outright
      // with "EIP-712 domain parameters (name, version) are required", so a
      // value has to be supplied. Verified empirically: a permit2 payment built
      // with these synthetic values passes our facilitator's signature check,
      // which it could not if the token domain were part of that signature.
      // ── extra ──────────────────────────────────────────────────────────
      //
      // `assetTransferMethod` lives INSIDE extra. As a top-level field it is
      // silently dropped, and this was caught by testing a real client against
      // the live 402 rather than by reading: the challenge looked right, and
      // the client happily built an EIP-3009-shaped payment for WETH — a token
      // with no transferWithAuthorization, so it would have reverted at settle.
      // An unpayable 402 that looks payable.
      //
      // The DOMAIN is load-bearing for EIP-3009 and must be exact: Base USDC
      // reports "USD Coin"/"2", and "USDC" — the obvious guess — produces a
      // signature the token rejects. For permit2 it is a client-side formality
      // (the signature is over Permit2's domain, not the token's) but omitting
      // it makes the client refuse outright, so a value must be supplied.
      extra: a.needsApproval
        ? { ...a.domain, assetTransferMethod: 'permit2' }
        : a.domain,
    }));

  // ── `extensions.bazaar`: how an agent finds us without being told ────────
  //
  // The CDP Bazaar is the discovery layer agents actually query — 14,562
  // resources on 2026-09-09, indexing continuously (90 of a 100-item sample
  // were under a day old). There is no submission form: a facilitator indexes
  // a resource when a payment for it settles, reading the declaration below.
  //
  // We already emitted the `resource` descriptor. This is the missing half,
  // and it was verified against a resource that IS indexed rather than from
  // the docs — api.onesource.io publishes exactly this shape, alongside a
  // `batch-settlement` option carrying its own receiverAuthorizer. Which is
  // also the proof that the hybrid works: self-facilitate the metered scheme,
  // and still be discoverable.
  //
  // The schemas are not decoration. A route that takes a body or a path
  // parameter and declares neither is listed but uncallable — an agent has no
  // way to construct a valid request, so the listing produces 404s instead of
  // players. The tournament route is the sharp case: its id is in the PATH.
  return {
    'POST /v1/matchmaking/queue': {
      resource: 'https://agents.goclubhouse.io/v1/matchmaking/queue',
      description: 'Ranked seat on the Clubhouse agent ladder',
      mimeType: 'application/json',
      accepts: options((a) => a.seatPrice),
      extensions: {
        bazaar: {
          info: {
            input: {
              type: 'http',
              method: 'POST',
              bodyFields: { game: 'chess', variant: 'live' },
            },
            output: {
              type: 'json',
              example: {
                success: true,
                status: 'queued',
                game: 'chess',
                asset: 'USDC',
              },
            },
          },
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                type: 'object',
                required: ['type', 'method', 'bodyFields'],
                properties: {
                  type: { const: 'http', type: 'string' },
                  method: { const: 'POST', type: 'string' },
                  bodyFields: {
                    type: 'object',
                    required: ['game'],
                    additionalProperties: false,
                    properties: {
                      game: {
                        type: 'string',
                        enum: ['chess', 'pool8', 'pool9', 'poker'],
                        description: 'Which game to queue for.',
                      },
                      variant: {
                        type: 'string',
                        description:
                          'Game-specific. "live" or "async" for chess; omit for the default.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    'POST /v1/tournaments/*/join': {
      resource: 'https://agents.goclubhouse.io/v1/tournaments/join',
      description: 'Buy-in to a Clubhouse agent tournament',
      mimeType: 'application/json',
      // MUST equal the origin's AGENT_PRICE_TOURNAMENT_BASE. That check is an
      // equality, not a floor, so a disagreement refuses every real payment —
      // the correct failure for a price that has drifted on a money route.
      accepts: options((a) => a.tournamentPrice),
      extensions: {
        bazaar: {
          info: {
            input: {
              type: 'http',
              method: 'POST',
              // The id is in the PATH, not the body, and an agent that does not
              // know that sends POST /v1/tournaments/join and gets a 404. The
              // whole point of declaring a schema is that it can construct a
              // valid call without reading our docs.
              pathParams: { tournamentId: '1' },
              bodyFields: {},
            },
            output: {
              type: 'json',
              example: { success: true, status: 'entered', tournamentId: 1 },
            },
          },
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                type: 'object',
                required: ['type', 'method', 'pathParams'],
                properties: {
                  type: { const: 'http', type: 'string' },
                  method: { const: 'POST', type: 'string' },
                  pathParams: {
                    type: 'object',
                    required: ['tournamentId'],
                    properties: {
                      tournamentId: {
                        type: 'string',
                        description:
                          'From GET /v1/tournaments. Only tournaments with agent_eligible accept an agent.',
                      },
                    },
                  },
                  bodyFields: { type: 'object', additionalProperties: false },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * A facilitator this module does not construct.
 *
 * Deliberate: x402.ts is about prices and schemes, and the entrypoint is where
 * dependencies get wired. It also keeps this file free of relative VALUE
 * imports — `x402Version.test.mjs` imports it directly under node's TS
 * type-stripping, where an extensionless relative import does not resolve, and
 * the suite stopped loading the moment one was added.
 */
export interface FacilitatorLike {
  verify(payload: unknown, requirements: unknown): Promise<unknown>;
  settle(payload: unknown, requirements: unknown): Promise<unknown>;
  getSupported(): Promise<unknown>;
}

let cached: { server: x402HTTPResourceServer; ready: Promise<void> } | null = null;

/** Build (once per isolate) and initialize the x402 resource server. */
export async function getPaymentServer(
  env: Env,
  /** Ours, supplied by the entrypoint. Absent falls back to a public one. */
  ownFacilitator?: FacilitatorLike,
): Promise<x402HTTPResourceServer> {
  if (!cached) {
    // ── Our own facilitator, by default ────────────────────────────────────
    //
    // The public ones disagree about permit2 and the default was the one that
    // gets it wrong: probed 2026-09-08, payai answered `isValid: true` for a
    // permit2 payment from an empty wallet, while xpay correctly refused it.
    // On the USDC/EIP-3009 path all of them are correct, so nothing in
    // production was ever wrong — but a permit2 asset cannot be enabled while
    // its validity rests on somebody else's broken check.
    //
    // This is not a loss of redundancy. The origin already has to be up for a
    // seat to be granted, so a facilitator beside it cannot fail independently
    // of what it gates; the public facilitator was never a fallback, it was a
    // second thing that had to work.
    //
    // X402_FACILITATOR_URL still forces a public one, which is the escape
    // hatch if ours ever needs taking out of the loop in a hurry.
    const client =
      env.X402_FACILITATOR_URL || !ownFacilitator
        ? new HTTPFacilitatorClient({
            url: env.X402_FACILITATOR_URL ?? MAINNET_FACILITATORS[0],
            timeoutMs: 20_000,
          })
        : ownFacilitator;

    const resourceServer = new x402ResourceServer(client as never);
    // Empty config registers the eip155:* wildcard, covering Base and Polygon.
    registerExactEvmScheme(resourceServer, {});

    const server = new x402HTTPResourceServer(resourceServer, buildRoutes(env) as never);
    cached = { server, ready: server.initialize() };
  }
  await cached.ready;
  return cached.server;
}

/** CAIP-2 → the origin's internal chain id. Mirrors origin.ts. */
function chainIdFor(network: string): string {
  if (network === NETWORK.baseSepolia) return 'base-sepolia';
  if (network === NETWORK.polygonMainnet) return 'polygon';
  return 'base-mainnet';
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
