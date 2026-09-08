/**
 * Edge rate limiting for the traffic nothing else limits.
 *
 * ## The gap this fills
 *
 * The origin meters agents per wallet, proven by signature, and that is the
 * right place for it — the wallet is the only thing that identifies an agent.
 * But it can only meter requests that HAVE a wallet.
 *
 * Discovery and match reads are deliberately public: chess and pool are perfect
 * information, and an agent deciding whether to spend a dollar should be able to
 * look first. Those requests carry no wallet, so they reach no wallet quota. The
 * origin's other limiter keys on client IP, and its own source comments explain
 * why that is useless here: every agent request arrives from Cloudflare, so it
 * throttles all agents collectively and none of them individually.
 *
 * The edge is the one place that sees the actual caller. `cf-connecting-ip` is
 * set by Cloudflare and cannot be spoofed by a client header, so this is the
 * only layer that can tell one anonymous reader from another — and it is also
 * the cheapest place to say no, since a refused request never reaches the
 * origin's database at all.
 *
 * ## Why a Durable Object and not KV
 *
 * Counting needs read-modify-write. KV is eventually consistent, so concurrent
 * requests read the same value and each write the same increment — a counter
 * that undercounts exactly when it matters, under a burst. A Durable Object is
 * single-threaded per id, so an increment is an increment.
 *
 * One instance per client IP, which also spreads the load: there is no single
 * hot object every request has to queue behind.
 *
 * ## Fails open
 *
 * Same reasoning the origin gives for its own quota. This is a backstop against
 * runaway loops and cheap abuse, not an authorisation decision — nothing here
 * decides who may do what. Turning a Durable Object hiccup into a total outage
 * of the read surface would be the worse failure by a distance.
 */

/** Requests per window, per client IP, across all anonymous reads. */
const DEFAULT_LIMIT = 300;
const WINDOW_MS = 60_000;

export interface QuotaVerdict {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

/**
 * A fixed-window counter, one instance per client IP.
 *
 * State is in memory rather than in storage. An evicted object forgets its
 * count, which hands the caller a fresh window — that is the fail-open
 * direction, it costs at most one window, and eviction requires the IP to have
 * gone idle, which is not the shape of an abusive caller. Paying a storage
 * write on every read to prevent it would be the wrong trade.
 */
export class AgentQuota {
  private count = 0;
  private windowStart = 0;

  async fetch(request: Request): Promise<Response> {
    const { limit = DEFAULT_LIMIT } = (await request.json().catch(() => ({}))) as {
      limit?: number;
    };

    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.count = 0;
      this.windowStart = now;
    }

    this.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((this.windowStart + WINDOW_MS - now) / 1000));

    const verdict: QuotaVerdict = {
      allowed: this.count <= limit,
      remaining: Math.max(0, limit - this.count),
      limit,
      resetSeconds,
    };
    return Response.json(verdict);
  }
}

interface QuotaEnv {
  QUOTA?: DurableObjectNamespace;
  AGENT_EDGE_QUOTA_PER_MIN?: string;
}

/**
 * Consume one unit of an anonymous caller's budget.
 *
 * Returns null when the request may proceed — including when the binding is
 * absent or the object is unreachable, which is the fail-open path.
 */
export async function consumeEdgeQuota(
  env: QuotaEnv,
  request: Request,
): Promise<QuotaVerdict | null> {
  if (!env.QUOTA) return null;

  // Set by Cloudflare on the way in and NOT forgeable by a client header — a
  // caller can send `cf-connecting-ip: 1.2.3.4` all it likes and the edge
  // overwrites it. That is what makes this usable as a limiter key at all.
  const ip = request.headers.get('cf-connecting-ip');
  // No IP means we cannot distinguish callers, and bucketing them all together
  // would throttle everyone the moment one of them misbehaves — which is the
  // exact failure the origin's IP limiter already has.
  if (!ip) return null;

  const limit = Number(env.AGENT_EDGE_QUOTA_PER_MIN || DEFAULT_LIMIT);

  try {
    const stub = env.QUOTA.get(env.QUOTA.idFromName(`ip:${ip}`));
    const res = await stub.fetch('https://quota/consume', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    });
    if (!res.ok) return null;
    return (await res.json()) as QuotaVerdict;
  } catch {
    return null;
  }
}
