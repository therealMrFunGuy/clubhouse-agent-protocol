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

import { getPaymentServer, adapterFor, paymentHeaderFrom, NETWORK } from './x402';
import { forwardToOrigin, chainIdForNetwork } from './origin';
import type { Env, AgentIdentity } from './types';

const ANON: AgentIdentity = { wallet: null, keyId: null, tier: 'anon' };

/** Read endpoints are free and unauthenticated — discovery should not be taxed. */
const PUBLIC_READS = [
  '/v1/games',
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
    if (request.method === 'GET' && PUBLIC_READS.some((p) => path.startsWith(p))) {
      const upstream = await forwardToOrigin(env, {
        method: 'GET',
        path: path.replace(/^\/v1/, '') + url.search,
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

    // ── Paid routes ─────────────────────────────────────────────────────────
    if (request.method === 'POST' && path.startsWith('/v1/')) {
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

      const result = (await server.processHTTPRequest(ctx as never)) as {
        type: string;
        response?: { status: number; headers: Record<string, string>; body: unknown };
        payment?: { payer?: string; network?: string };
      };

      // Unpaid (or invalid) — hand back the 402 challenge verbatim.
      if (result.type === 'payment-error' && result.response) {
        return new Response(JSON.stringify(result.response.body ?? {}), {
          status: result.response.status,
          headers: {
            ...result.response.headers,
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
          },
        });
      }

      // Paid. The payer address is proven by signature — this is the identity.
      const payer = result.payment?.payer ?? null;
      const network = result.payment?.network ?? env.X402_NETWORK ?? NETWORK.baseMainnet;
      if (!payer) {
        return json({ error: 'Payment verified but no payer resolved' }, 500);
      }

      // TODO(phase-3): replay-nonce check, quota, and payout circuit breaker
      // MUST land here before any money route is enabled in production.
      const identity: AgentIdentity = { wallet: payer, keyId: null, tier: 'ranked' };

      const upstream = await forwardToOrigin(env, {
        method: 'POST',
        path: path.replace(/^\/v1/, ''),
        body: await request.json().catch(() => ({})),
        identity,
        settledNetwork: network,
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
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
@clubhouse/pool-sim so you can search shots offline before committing.

Poker is deliberately not exposed (hidden information).
Bug bounty: https://github.com/therealMrFunGuy/clubhouse-agent-protocol/blob/main/SECURITY.md
`;
