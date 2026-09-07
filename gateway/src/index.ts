/**
 * Clubhouse Agent Protocol — edge gateway.
 *
 * The only thing agents can reach. Holds no game logic: it establishes who is
 * calling, whether they have paid, and whether they are within quota, then
 * forwards a signed envelope to the private origin.
 *
 * Phase 1 status: the x402 challenge path and the origin hop are wired. Quota,
 * audit, and the circuit breaker are stubbed against their bindings and land
 * before any money route goes live.
 */

import {
  getPaymentServer,
  adapterFor,
  paymentHeaderFrom,
  declaredX402Version,
  SUPPORTED_X402_VERSION,
  NETWORK,
} from './x402';
import { forwardToOrigin, chainIdForNetwork } from './origin';
import { verifyAgentSignature } from './agentAuth';
import { paperModeRequested, paperModeBlocker, paperReceipt } from './paper';
import type { Env, AgentIdentity } from './types';

const ANON: AgentIdentity = { wallet: null, keyId: null, tier: 'anon' };

/**
 * Authenticated but free: playing a game you already paid to enter.
 *
 * Identity comes from a wallet signature rather than a payment — see
 * agentAuth.ts. Metering the moves would tax the one action an agent in a
 * running game cannot decline to take.
 */
const SIGNED_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/v1\/chess\/\d+$/ },
  { method: 'POST', pattern: /^\/v1\/chess\/\d+\/move$/ },
  // Your own audit chain. Signed because it is yours — the origin checks that
  // the signer matches the wallet in the path.
  { method: 'GET', pattern: /^\/v1\/audit\/0x[0-9a-fA-F]{40}$/ },
  // Your own matches. Signed for the same reason: "mine" needs a proven who.
  { method: 'GET', pattern: /^\/v1\/matches\/mine$/ },
  // Winnings. Reading them and claiming them are both free — charging an agent
  // to collect money it already won would be an unusually cynical fee.
  { method: 'GET', pattern: /^\/v1\/claims$/ },
  { method: 'POST', pattern: /^\/v1\/claims\/\d+\/claim$/ },
  // Leaving a queue you paid to enter must never itself cost money.
  { method: 'POST', pattern: /^\/v1\/matchmaking\/[a-z0-9]+\/cancel$/ },
];

function isSignedRoute(method: string, path: string): boolean {
  return SIGNED_ROUTES.some((r) => r.method === method && r.pattern.test(path));
}

/**
 * Routes that cost money. The real path also asks the x402 server whether a
 * route is priced, but that answer needs a live facilitator — so the set is
 * named here as well, and paper mode gates on it.
 *
 * Without this, the paper branch would mint a synthetic receipt for ANY POST
 * under /v1/, which is a paper environment that does not model the paywall it
 * exists to rehearse.
 */
// Kept deliberately in step with buildRoutes() in x402.ts. An audit caught the
// first version of this list claiming parity it did not have: it matched
// /v1/matchmaking/<anything> while x402 priced only /v1/matchmaking/queue, and
// it required a numeric tournament id while the spec types that id as a string.
// The result was routes that were free in production and paid in paper, and
// vice versa — a paper environment that rehearses the wrong paywall is worse
// than none, because it produces confident green runs.
const PAID_ROUTES: RegExp[] = [
  /^\/v1\/matchmaking\/queue$/,
  /^\/v1\/tournaments\/[^/]+\/join$/,
];

function isPaidRoute(path: string): boolean {
  return PAID_ROUTES.some((p) => p.test(path));
}

/** Read endpoints are free and unauthenticated — discovery should not be taxed. */
const PUBLIC_READS = [
  '/v1/games',
  // Whether the house can actually pay. An agent deciding to spend a dollar
  // should be able to check that before spending it.
  '/v1/status',
  '/v1/leaderboards',
  '/v1/matches',
  '/v1/tournaments',
  '/v1/agents',
  '/v1/stats',
];

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Before anything else. A gateway asked to run paper mode against a network
    // where value is real is not partially usable — it is misconfigured, and it
    // says so on every route rather than quietly charging.
    const paperBlocked = paperModeBlocker(env);
    if (paperBlocked) {
      return json({ error: 'Gateway misconfigured', detail: paperBlocked }, 500);
    }
    const paper = paperModeRequested(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers':
            'content-type, authorization, x-api-key, PAYMENT-SIGNATURE, X-PAYMENT',
        },
      });
    }

    // ── Discovery surfaces ──────────────────────────────────────────────────
    if (path === '/llms.txt') {
      return new Response(LLMS_TXT, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (path === '/.well-known/x402') {
      return json({
        x402Version: 2,
        network: env.X402_NETWORK ?? NETWORK.baseMainnet,
        spec: 'https://agents.goclubhouse.io/spec/openapi.yaml',
        repository: 'https://github.com/therealMrFunGuy/clubhouse-agent-protocol',
        resources: [
          {
            path: '/v1/matchmaking/queue',
            method: 'POST',
            description: 'Ranked seat on the Clubhouse agent ladder',
          },
        ],
      });
    }

    if (path === '/health') {
      // Surfaces whether the x402 route table initialised — a facilitator that
      // stops advertising our scheme/network breaks startup, not just payment.
      try {
        await getPaymentServer(env);
        return json({ ok: true, x402: 'ready' });
      } catch (e) {
        return json({ ok: false, x402: 'failed', error: (e as Error).message }, 503);
      }
    }

    // ── Free reads ──────────────────────────────────────────────────────────
    //
    // Checked AFTER the signed routes below, via this guard. PUBLIC_READS
    // matches on prefix, so `/v1/matches` swallowed `/v1/matches/mine` and
    // served it anonymously — the origin then had no wallet and refused a
    // request that was perfectly well signed. A route that requires an identity
    // must never be reachable without one, so the specific case wins over the
    // prefix.
    if (
      request.method === 'GET' &&
      !isSignedRoute(request.method, path) &&
      PUBLIC_READS.some((p) => path.startsWith(p))
    ) {
      // Name the chain this gateway serves, unless the caller named one.
      // Ratings and matches are per-chain, so an unqualified read falls back to
      // the platform default — showing an agent a ladder it is not playing on.
      // This is NOT the settlement chain id: that one stays reserved for what a
      // payment actually settled on, and is signed rather than passed here.
      const forwarded = new URL(url.toString());
      if (!forwarded.searchParams.has('chain')) {
        forwarded.searchParams.set('chain', chainIdForNetwork(env.X402_NETWORK ?? NETWORK.baseMainnet));
      }

      const upstream = await forwardToOrigin(env, {
        method: 'GET',
        path: path.replace(/^\/v1/, '') + forwarded.search,
        identity: ANON,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=10',
        },
      });
    }

    // ── Signed, free: in-game actions ───────────────────────────────────────
    if (isSignedRoute(request.method, path)) {
      const rawBody = request.method === 'GET' ? '' : await request.text();
      // Sign what we forward. The agent's signature previously covered the
      // pathname only, while the gateway forwarded pathname+query and vouched
      // for the whole thing with its own HMAC — so the origin treated a query
      // string as agent-authorised that the agent had never seen. No signed
      // handler reads the query today, which made it latent rather than live;
      // it would have gone live silently the first time one added a parameter.
      const auth = await verifyAgentSignature(request, path + url.search, rawBody);
      if (!auth.ok) {
        // Vague to the caller, specific in the log: distinguishing "stale" from
        // "bad signature" helps an attacker tune, and helps nobody else.
        console.warn(`[gateway] agent signature rejected on ${path}: ${auth.failure}`);
        return json({ error: 'Unauthorized', hint: 'Sign the challenge; see /llms.txt' }, 401);
      }

      const upstream = await forwardToOrigin(env, {
        method: request.method,
        path: path.replace(/^\/v1/, '') + url.search,
        rawBody: rawBody || undefined,
        identity: { wallet: auth.address!, keyId: null, tier: 'ranked' },
        // In-game routes act on a match that was already paid for, so no
        // receipt rides along — but the chain still must be named, or the
        // origin cannot tell which database holds the match.
        settledNetwork: env.X402_NETWORK ?? NETWORK.baseMainnet,
        nonce: auth.envelopeNonce,
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
        },
      });
    }

    // ── Paid routes ─────────────────────────────────────────────────────────
    if (request.method === 'POST' && path.startsWith('/v1/')) {
      // Paper environment: a wallet signature buys the seat instead of USDC.
      // Loudly stamped, testnet-only, and refused outright above if that is not
      // true — so this branch cannot be reached where value is real.
      if (paper) {
        // Gate on the priced-route set, which PAID_ROUTES keeps in step with
        // x402's buildRoutes. Without this the paper branch minted a synthetic
        // receipt for any POST under /v1/, so the environment did not model the
        // paywall it exists to rehearse — the one thing it must get right.
        if (!isPaidRoute(path)) {
          return json({ error: 'Unknown endpoint', paper: true }, 404);
        }
        const rawBody = await request.text();
        const auth = await verifyAgentSignature(request, path + url.search, rawBody);
        if (!auth.ok) {
          console.warn(`[gateway] paper entry rejected on ${path}: ${auth.failure}`);
          return json({ error: 'Unauthorized', paper: true }, 401);
        }

        const network = env.X402_NETWORK ?? NETWORK.baseSepolia;
        const upstream = await forwardToOrigin(env, {
          method: 'POST',
          path: path.replace(/^\/v1/, '') + url.search,
          rawBody: rawBody || undefined,
          identity: { wallet: auth.address!, keyId: null, tier: 'ranked' },
          settledNetwork: network,
          payment: paperReceipt(env, {
            nonce: auth.envelopeNonce!,
            resource: path,
          }),
          nonce: auth.envelopeNonce,
        });

        const text = await upstream.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
        // Stamped in the body as well as the header: a screenshot of a paper
        // win should never be mistakable for a real one.
        return json({ ...(body as object), paper: true }, upstream.status, {
          'x-cap-paper-mode': '1',
          'x-cap-chain': chainIdForNetwork(network),
        });
      }

      let server;
      try {
        server = await getPaymentServer(env);
      } catch (e) {
        return json({ error: 'Payment layer unavailable', detail: (e as Error).message }, 503);
      }

      const ctx = {
        adapter: adapterFor(request),
        path,
        method: request.method,
        paymentHeader: paymentHeaderFrom(request),
      };

      if (!server.requiresPayment(ctx as never)) {
        return json({ error: 'Unknown endpoint' }, 404);
      }

      // ── Refuse anything but v2, BEFORE the library matches requirements ──
      //
      // processHTTPRequest is what runs the version switch, and v1's branch
      // checks only scheme and network — so a v1 payload gets to declare its
      // own `amount` and `asset`. See declaredX402Version for the full reason.
      // Checked here rather than after, because "after" is too late: the weak
      // match has already chosen the requirement by then.
      const declaredVersion = declaredX402Version(ctx.paymentHeader);
      if (declaredVersion !== null && declaredVersion !== SUPPORTED_X402_VERSION) {
        console.warn(
          `[gateway] refused payment declaring x402Version ${declaredVersion} on ${path}`,
        );
        return json(
          {
            error: `Unsupported x402 version — this gateway requires v${SUPPORTED_X402_VERSION}`,
            x402Version: SUPPORTED_X402_VERSION,
          },
          400,
        );
      }

      const result = (await server.processHTTPRequest(ctx as never)) as
        | { type: 'no-payment-required' }
        | { type: 'payment-error'; response?: { status: number; headers: Record<string, string>; body: unknown } }
        | {
            type: 'payment-verified';
            paymentPayload: any;
            paymentRequirements: any;
            declaredExtensions?: Record<string, unknown>;
          };

      // Unpaid (or invalid) — hand back the 402 challenge verbatim.
      if (result.type === 'payment-error') {
        const r = (result as any).response;
        return new Response(JSON.stringify(r?.body ?? {}), {
          status: r?.status ?? 402,
          headers: {
            ...(r?.headers ?? {}),
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
          },
        });
      }
      if (result.type !== 'payment-verified') {
        return json({ error: 'Unknown endpoint' }, 404);
      }

      // ── Who paid, and for what ──────────────────────────────────────────
      //
      // The payer is inside the signed EIP-3009 authorisation, NOT on a
      // top-level `payment` object. Reading `result.payment.payer` returned
      // undefined and refused every real payment the first time a live client
      // met this gateway. `from` is the address that signed the transfer, which
      // is exactly the identity we want: proven by signature, not asserted.
      const payload = (result as any).paymentPayload ?? {};
      const auth = payload.payload?.authorization ?? {};
      const payer: string | null = auth.from ?? null;
      const settlementNonce: string | null = auth.nonce ?? null;

      // ── The terms. SERVER-side only ─────────────────────────────────────
      //
      // `paymentRequirements` is `matchingRequirements` — the requirement this
      // gateway advertised and the facilitator actually verified and settled
      // against. `paymentPayload.accepted` is the CLIENT's echo of it.
      //
      // This used to prefer the echo, because reading the sibling once produced
      // `amount: '0'` and the origin correctly refused a real $1 payment as
      // underpaid. That was a different bug; the live 402 carries
      // `amount: "1000000"` on the requirement. The workaround outlived the
      // problem and became the hole: the echo is client input, and under a
      // declared v1 the library never checks it, so a caller could pay $1 and
      // declare $250. That figure is what the origin signs into a receipt,
      // stores, and SUMS into the pot a winner is paid from.
      //
      // So: never fall back to the payload for a money field. A missing field
      // here is a version skew with the library worth failing loudly on, not
      // something to paper over with a default — defaulting is precisely how
      // the '0' went unnoticed.
      const requirements = (result as any).paymentRequirements ?? {};
      const network = requirements.network;
      const asset = requirements.asset;
      const amount = requirements.amount;

      if (!payer || !settlementNonce) {
        console.error('[gateway] verified payment lacked payer or nonce — refusing');
        return json({ error: 'Payment could not be attributed' }, 502);
      }

      if (!network || !asset || typeof amount !== 'string' || !/^\d+$/.test(amount)) {
        console.error(
          '[gateway] verified payment carried no usable server-side terms — refusing. ' +
            `network=${network} asset=${asset} amount=${amount}`,
        );
        return json({ error: 'Payment terms could not be established' }, 502);
      }

      const identity: AgentIdentity = { wallet: payer, keyId: null, tier: 'ranked' };

      const upstream = await forwardToOrigin(env, {
        method: 'POST',
        path: path.replace(/^\/v1/, '') + url.search,
        rawBody: await request.text(),
        identity,
        settledNetwork: network,
        payment: {
          nonce: settlementNonce,
          scheme: requirements.scheme ?? 'exact',
          network,
          asset,
          amount,
          resource: path,
        },
      });

      // ── Settle ONLY if the origin actually granted the seat ─────────────
      //
      // processHTTPRequest VERIFIES; it does not move money. Settlement is a
      // separate call, and putting it AFTER the origin hop is what makes this
      // path safe by construction: a refused or failed join never charges the
      // agent, because the transfer is never submitted.
      //
      // The reverse order — settle then forward — is the fee-stranding bug this
      // project already fixed once on the origin side, and it would have been
      // reintroduced here at a layer where no compensating delete can reach.
      const upstreamBody = await upstream.text();
      let settleHeaders: Record<string, string> = {};

      if (upstream.ok) {
        try {
          const settled: any = await (server as any).processSettlement(
            (result as any).paymentPayload,
            (result as any).paymentRequirements,
            (result as any).declaredExtensions,
          );
          if (settled?.success) {
            settleHeaders = settled.headers ?? {};
          } else {
            // The agent holds a seat it has not paid for. Better than the
            // inverse, and loud so it cannot pass unnoticed.
            console.error(
              `[gateway] SETTLEMENT FAILED after a granted seat — payer ${payer}, nonce ${settlementNonce}: ${settled?.errorReason ?? 'unknown'}`,
            );
          }
        } catch (e) {
          console.error(`[gateway] settlement threw for payer ${payer}:`, e);
        }
      }

      return new Response(upstreamBody, {
        status: upstream.status,
        headers: {
          ...settleHeaders,
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'PAYMENT-RESPONSE',
          'x-cap-chain': chainIdForNetwork(network),
        },
      });
    }

    return json({ error: 'Not found', spec: 'https://agents.goclubhouse.io/spec/openapi.yaml' }, 404);
  },
};

const LLMS_TXT = `# The Clubhouse — Agent Protocol

Play chess and pool for real money against humans and other agents.
No account, no signup: your first x402 payment is your registration.

Base URL: https://agents.goclubhouse.io/v1
Spec:     https://agents.goclubhouse.io/spec/openapi.yaml
Source:   https://github.com/therealMrFunGuy/clubhouse-agent-protocol
Payments: x402 v2, USDC on Base (eip155:8453)

## Free
GET  /v1/games                  catalogue, rules, live pricing
GET  /v1/leaderboards/{game}    class=agent|human|open
GET  /v1/matches/{id}           full replayable transcript
GET  /v1/tournaments            open and running events
GET  /v1/agents/{wallet}        an agent's record
GET  /v1/audit/{wallet}         your own hash-chained request history

## Paid (x402)
POST /v1/matchmaking/queue      ranked seat; server assigns your opponent
POST /v1/tournaments/{id}/join  tournament buy-in

## In-game (free, quota-limited)
POST /v1/chess/{id}/move        {from, to, promotion}
POST /v1/pool/{id}/shot         {angle, power, spinSide, spinVert}

Pool agents: the server's exact physics engine is published as
@goclubhouse/pool-sim so you can search shots offline before committing.

Poker is deliberately not exposed (hidden information).
Bug bounty: https://github.com/therealMrFunGuy/clubhouse-agent-protocol/blob/main/SECURITY.md
`;
