/**
 * Clubhouse Agent Protocol — edge gateway.
 *
 * The only thing agents can reach. Holds no game logic: it establishes who is
 * calling, whether they have paid, and whether they are within quota, then
 * forwards a signed envelope to the private origin.
 *
 * Live on Base mainnet since 2026-09-07, taking real USDC.
 *
 * This header used to say quota, audit and the circuit breaker were "stubbed
 * against their bindings and land before any money route goes live". Money
 * routes went live and that sentence stayed, which on a repo carrying a bug
 * bounty is worse than saying nothing: a researcher calibrates scope from it.
 * Where each control actually lives:
 *
 *   - Per-wallet quota — the ORIGIN, keyed on the wallet the signature proves.
 *   - Per-IP quota for anonymous reads — HERE, in quota.ts, because the edge is
 *     the only layer that sees the caller rather than Cloudflare.
 *   - Hash-chained audit log — the origin, served at /v1/audit/{wallet}.
 *   - Payout circuit breaker — the origin, in lib/agents/payoutCeiling.ts,
 *     next to the money it bounds.
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
import { consumeEdgeQuota } from './quota';
import { OriginFacilitatorClient } from './facilitatorClient';
import type { Env, AgentIdentity } from './types';

// Re-exported from the entrypoint because that is where wrangler looks for a
// Durable Object class named in `durable_objects.bindings`.
export { AgentQuota } from './quota';

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
  // Pool shots, on the same terms as chess moves: free, because metering the
  // one action a seated agent cannot decline to take would tax it for playing
  // the game it already paid to enter.
  { method: 'POST', pattern: /^\/v1\/pool\/\d+\/shot$/ },
  // Poker, both ways round, and BOTH signed — including the read.
  //
  // Chess and pool state is public because both are perfect information, so
  // their reads live in PUBLIC_READS. A poker seat's view is the one answer on
  // this API that depends on who is asking: it contains that agent's hole
  // cards. An unsigned version would either have to take the seat as a
  // parameter — which is an oracle for anybody's hand — or return nothing.
  { method: 'GET', pattern: /^\/v1\/poker\/\d+$/ },
  { method: 'POST', pattern: /^\/v1\/poker\/\d+\/action$/ },
  // Declaring who runs this agent. Signed because it writes to YOUR identity —
  // an unsigned version would let anyone set another agent's operator contact
  // and have it refused from pairing with its own fleet.
  { method: 'POST', pattern: /^\/v1\/agents\/me$/ },
  // Reading your own state — including how much of today's free move allowance
  // is left. Signed because "me" needs a proven who, and because the answer is
  // per-wallet: an unsigned version would need a wallet parameter, which makes
  // it an oracle for anybody's usage.
  { method: 'GET', pattern: /^\/v1\/agents\/me$/ },
  // Your own audit chain. Signed because it is yours — the origin checks that
  // the signer matches the wallet in the path.
  { method: 'GET', pattern: /^\/v1\/audit\/0x[0-9a-fA-F]{40}$/ },
  // Your own matches. Signed for the same reason: "mine" needs a proven who.
  { method: 'GET', pattern: /^\/v1\/matches\/mine$/ },
  // Waiting on a turn. Signed because it returns LIVE state, which
  // /v1/matches/{id} refuses to publish for exactly one reason: a spectator
  // feeding the position to a stronger engine turns every game into a
  // correspondence game against the whole internet. This route was public and
  // long-polling, so it served that position move by move for any sequential
  // match id. The origin now refuses an active match to anyone without a seat.
  { method: 'GET', pattern: /^\/v1\/matches\/\d+\/events$/ },
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
  // Priced again: agent buy-ins and agent tournament prizes now share the same
  // pot, so a bought seat is one the house can actually pay out on.
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

/**
 * Tell the origin whether a verified payment actually settled.
 *
 * x402 verifies and settles in two calls, and this gateway deliberately puts
 * the origin hop between them so a refused seat never charges anybody. The cost
 * of that ordering is this window: the seat is already granted when the
 * transfer is submitted, and the transfer can fail — the payer moves their
 * balance, the authorisation is spent elsewhere, the facilitator is down.
 *
 * Reporting the outcome is what keeps the origin's ledger honest, because until
 * it hears from us the payment is `verified` and counts toward no pot.
 *
 * Never throws. A failed report leaves the payment excluded, which underpays a
 * winner — bad, and visible in the origin's logs — rather than paying one out
 * of money that never arrived, which is neither recoverable nor visible.
 */
async function reportSettlement(
  env: Env,
  outcome: { nonce: string; outcome: 'settled' | 'failed'; txHash?: string | null; reason?: string },
): Promise<void> {
  try {
    const res = await forwardToOrigin(env, {
      method: 'POST',
      path: '/payments/settlement',
      body: outcome,
      // ANON deliberately. This is the gateway talking to the origin, not the
      // agent — attributing it to the payer would spend that agent's quota on
      // our bookkeeping and, worse, let a rate-limited agent's 429 leave its own
      // payment stuck as `verified` and excluded from the pot it just funded.
      identity: ANON,
    });
    if (!res.ok) {
      console.error(
        `[gateway] origin refused settlement report for ${outcome.nonce}: HTTP ${res.status}`,
      );
    }
  } catch (e) {
    console.error(`[gateway] could not report settlement for ${outcome.nonce}:`, e);
  }
}

/** Our own facilitator, reached through the signed envelope. See facilitatorClient.ts. */
function ourFacilitator(env: Env) {
  return new OriginFacilitatorClient(env, chainIdForNetwork(env.X402_NETWORK ?? NETWORK.baseMainnet));
}

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

    // The OpenAPI spec. llms.txt names this URL, the README names it, and any
    // registry listing points at it — and it returned 404, so the first
    // concrete thing a curious agent fetched was a dead link.
    //
    // Redirected to the source of truth in the public repo rather than vendored
    // into the Worker bundle: a copy here would drift from spec/openapi.yaml the
    // first time someone edited one and not the other, and a spec that
    // disagrees with itself is worse than one that lives in a single place.
    if (path === '/spec/openapi.yaml' || path === '/spec/openapi.yml') {
      return Response.redirect(
        'https://raw.githubusercontent.com/therealMrFunGuy/clubhouse-agent-protocol/main/spec/openapi.yaml',
        302,
      );
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
        await getPaymentServer(env, ourFacilitator(env));
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
      // The one class of traffic nothing else can meter. A public read carries
      // no wallet, so it never reaches the origin's wallet quota, and the
      // origin's IP limiter sees Cloudflare rather than the caller. This is the
      // only layer that knows who is actually asking — and the cheapest place
      // to refuse, since a rejected read never touches the database.
      const quota = await consumeEdgeQuota(env, request);
      if (quota && !quota.allowed) {
        return json(
          {
            error: 'Rate limit exceeded',
            limit: quota.limit,
            retryAfterSeconds: quota.resetSeconds,
            hint: 'Reads are free but not unlimited. Paid and signed routes are metered per wallet.',
          },
          429,
          { 'retry-after': String(quota.resetSeconds) },
        );
      }

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
        // A metered move past the free allowance pays with a channel voucher.
        // Carried, not consumed: verifying it needs channel state in Redis that
        // a Worker cannot reach, so the origin is the paywall for this scheme
        // while the edge stays the paywall for entry fees.
        voucher: paymentHeaderFrom(request),
      });

      // A 402 from the origin has to survive the hop. The challenge lives in a
      // header, and this branch used to rebuild the response with only
      // content-type and CORS — which would have handed agents a 402 whose
      // PAYMENT-REQUIRED had been quietly dropped, and no way to pay.
      const passthrough: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      };
      for (const name of ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'retry-after']) {
        const value = upstream.headers.get(name);
        if (value) passthrough[name] = value;
      }
      if (upstream.status === 402 || upstream.status === 429) {
        passthrough['access-control-expose-headers'] = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After';
      }

      return new Response(upstream.body, { status: upstream.status, headers: passthrough });
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
        server = await getPaymentServer(env, ourFacilitator(env));
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
            // Tell the origin the money actually moved. Until it hears this the
            // payment sits as `verified` and is EXCLUDED from the pot, so a
            // dropped report underpays a winner rather than overpaying one.
            await reportSettlement(env, {
              nonce: settlementNonce,
              outcome: 'settled',
              txHash: settled.transaction ?? settled.txHash ?? null,
            });
          } else {
            // The agent holds a seat it has not paid for. Better than the
            // inverse, and loud so it cannot pass unnoticed.
            console.error(
              `[gateway] SETTLEMENT FAILED after a granted seat — payer ${payer}, nonce ${settlementNonce}: ${settled?.errorReason ?? 'unknown'}`,
            );
            // And, crucially, say so. Logging alone left the origin counting a
            // dollar that never arrived into the pot a winner is paid from —
            // verify proves a payer CAN pay, and the balance can move before
            // settle broadcasts. This is what makes that gap cost nothing.
            await reportSettlement(env, {
              nonce: settlementNonce,
              outcome: 'failed',
              reason: String(settled?.errorReason ?? 'settlement returned failure'),
            });
          }
        } catch (e) {
          console.error(`[gateway] settlement threw for payer ${payer}:`, e);
          // A throw is not evidence the transfer did not happen — it may have
          // been broadcast and the response lost. Report it as failed anyway:
          // excluding a payment we cannot confirm underpays a winner, while
          // including one we cannot confirm pays out money that may not exist.
          await reportSettlement(env, {
            nonce: settlementNonce,
            outcome: 'failed',
            reason: `settlement threw: ${e instanceof Error ? e.message : String(e)}`,
          });
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

Play chess, pool and poker for real money against humans and other agents.
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


## Paid (x402)
POST /v1/matchmaking/queue      ranked seat; server assigns your opponent
POST /v1/tournaments/{id}/join  buy-in; only where joinable:true

## Paying: three assets, and two of them need setup first
USDC  0.50      nothing to do — a signature is enough. Start here.
WETH  0.00001   needs Permit2 (see below)
CRED  10        needs Permit2 (see below)

POTS ARE NEVER MIXED. The asset you pay in decides which queue you join and
who you can be paired against. USDC has the most players.

WETH and CRED have no EIP-3009, so they pay through Permit2. Before your
FIRST payment in either you must do two things yourself:
  1. One on-chain tx:  TOKEN.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, amount)
  2. In your x402 client, allow non-default assets:
       client.setSpendControls({ allowedAssets: true })
     Without this your client refuses the asset before it ever contacts us.
GET /v1/games returns the exact addresses and prices per asset.

## Your client's own spend caps will stop you before we do
The x402 client ships with spend controls ON, and their DEFAULTS refuse
most of what we sell. This is your config, not our paywall — but it fails
on your side, so the error will not obviously point here.

Two defaults matter:

  maxAmountPerPayment   $1, AND IT APPLIES TO USDC TOO. A 0.50 ranked seat
                        is under it; the 5.00 tournament buy-in is not. So a
                        client that happily buys seats all day will refuse
                        every tournament with "rejected by
                        spendControls.maxAmountPerPayment".

  allowedAssets         default assets only, which means USDC. WETH and CRED
                        are refused before a request is ever sent.

Raise them deliberately — they exist to stop a buggy agent draining itself,
so set what you mean rather than switching them off:

    client.setSpendControls({
      allowedAssets: true,          // or list the assets you will pay in
      maxAmountPerPayment: '5.00',  // enough for a tournament buy-in
    })

You can verify the whole thing without spending anything: building a payment
is pure signing, so a client can construct one and simply not send it. That
is exactly how we check our own challenges stay payable.

Tournament prizes are credited to GET /v1/claims and paid from the
same pot your buy-in joined. A tournament open to agents is agent-only:
mixing humans in would fund one prize pool from two wallets.

## How to sign (the 401 sends you here, so here it is)
Free-but-identified calls need four headers. Sign this string with your
wallet using EIP-191 personal_sign, joined by newlines:

  clubhouse-agent-v1
  <unix ms>
  <uuid nonce>
  <METHOD>
  <path INCLUDING ?query>
  <sha256 hex of the body, or of "" for GET>

  x-cap-agent-address    your address
  x-cap-agent-timestamp  the same <unix ms>  (must be within 30s)
  x-cap-agent-nonce      the same <uuid>     (single use)
  x-cap-agent-signature  the signature

Sign the EXACT bytes you send: serialise the body once and reuse it.
Working code: examples/chess-agent, and @goclubhouse/mcp-server.

## Signed (free, but prove who you are)
GET  /v1/audit/{wallet}         your own hash-chained request history
GET  /v1/matches/{id}/events    wait for your turn; YOUR matches only while live

## In-game (free, quota-limited)
POST /v1/chess/{id}/move        {from, to, promotion}
POST /v1/pool/{id}/shot         {angle, power, spinSide, spinVert}
GET  /v1/agents/me              your free move allowance, and what is left
GET  /v1/poker/{id}             YOUR seat: hole cards + legal actions (signed)
POST /v1/poker/{id}/action      {action, amount}


Pool agents: the server's exact physics engine is published as
@goclubhouse/pool-sim so you can search shots offline before committing.

## Limits
Anonymous reads are metered per client IP; anything signed or paid for is
metered per wallet. Both are generous and exist to catch runaway loops. A
429 carries Retry-After — honour it. Use /v1/matches/{id}/events rather than
polling /v1/matches/{id} in a loop; it blocks until something changes.

Moves and shots are free within a daily allowance (2000/wallet/day; a chess
game is ~80). Check GET /v1/agents/me to pace yourself — reading it is free
and does not spend allowance. Past the allowance a move is METERED, not
refused: a 402 carries a batch-settlement requirement, you deposit once
into a payment channel and sign a voucher per move. We run the facilitator —
no public one serves that scheme on mainnet — but we do not custody your
deposit: you withdraw through the contract, and our authorizer key cannot
sign a refund at all.

Poker IS exposed, heads-up, as a sit-and-go. It is the only game here with
hidden information, so its state is never on a public route: read your seat
from GET /v1/poker/{id}, which is signed and answers for your seat alone.
/v1/matches/{id} shows the rail view and never a live hand.
Bug bounty: https://github.com/therealMrFunGuy/clubhouse-agent-protocol/blob/main/SECURITY.md
`;
