/**
 * The edge quota, and the traffic it exists for.
 *
 * Public reads carry no wallet, so the origin's wallet-keyed quota never sees
 * them, and the origin's other limiter keys on client IP — which for agent
 * traffic is a Cloudflare address, putting every agent in one bucket. The edge
 * is the only layer that knows who is actually calling.
 *
 * The property that matters most here is not that it counts. It is that it
 * FAILS OPEN in every direction: no binding, no client IP, an unreachable
 * object. A backstop against runaway loops must never be able to take the read
 * surface down, and each of those paths is one somebody could accidentally
 * invert into a refusal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentQuota, consumeEdgeQuota } from '../src/quota.ts';

const req = (limit) =>
  new Request('https://quota/consume', { method: 'POST', body: JSON.stringify({ limit }) });

async function verdict(obj, limit) {
  return (await obj.fetch(req(limit))).json();
}

test('counts within a window and refuses past the limit', async () => {
  const q = new AgentQuota();
  for (let i = 1; i <= 3; i++) {
    const v = await verdict(q, 3);
    assert.equal(v.allowed, true, `request ${i} should be allowed`);
  }
  const over = await verdict(q, 3);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
});

test('reports a retry-after the caller can actually use', async () => {
  const q = new AgentQuota();
  const v = await verdict(q, 1);
  // Never zero: a retry-after of 0 invites an immediate retry, which is the
  // behaviour the limit is trying to stop.
  assert.ok(v.resetSeconds >= 1);
  assert.ok(v.resetSeconds <= 60);
});

test('a fresh window admits the caller again', async () => {
  const q = new AgentQuota();
  await verdict(q, 1);
  assert.equal((await verdict(q, 1)).allowed, false);

  // Wind the window back rather than sleeping a minute in a test.
  q.windowStart = Date.now() - 61_000;
  assert.equal((await verdict(q, 1)).allowed, true);
});

test('separate instances do not share a budget', async () => {
  // One object per IP is what makes this per-caller rather than global. If they
  // shared, one abusive reader would throttle everybody — the exact failure the
  // origin's IP limiter already has.
  const a = new AgentQuota();
  const b = new AgentQuota();
  await verdict(a, 1);
  assert.equal((await verdict(a, 1)).allowed, false);
  assert.equal((await verdict(b, 1)).allowed, true);
});

test('a malformed body falls back to the default limit rather than throwing', async () => {
  const q = new AgentQuota();
  const res = await q.fetch(new Request('https://quota/consume', { method: 'POST' }));
  const v = await res.json();
  assert.equal(v.allowed, true);
  assert.equal(v.limit, 300);
});

// ── Failing open ─────────────────────────────────────────────────────────────

test('no QUOTA binding means no limit, not no service', async () => {
  const r = new Request('https://agents.test/v1/games', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  });
  assert.equal(await consumeEdgeQuota({}, r), null);
});

test('no client IP means no limit — bucketing everyone together is worse', async () => {
  // Lumping unattributable callers into one bucket would throttle all of them
  // the moment one misbehaved, which is the failure this replaces rather than
  // reproduces.
  const env = { QUOTA: { idFromName: () => 'id', get: () => { throw new Error('unreachable'); } } };
  assert.equal(await consumeEdgeQuota(env, new Request('https://agents.test/v1/games')), null);
});

test('an unreachable Durable Object means no limit', async () => {
  const env = {
    QUOTA: {
      idFromName: () => 'id',
      get: () => ({ fetch: async () => { throw new Error('DO down'); } }),
    },
  };
  const r = new Request('https://agents.test/v1/games', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  });
  assert.equal(await consumeEdgeQuota(env, r), null);
});

test('a non-OK response from the object means no limit', async () => {
  const env = {
    QUOTA: {
      idFromName: () => 'id',
      get: () => ({ fetch: async () => new Response('nope', { status: 500 }) }),
    },
  };
  const r = new Request('https://agents.test/v1/games', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  });
  assert.equal(await consumeEdgeQuota(env, r), null);
});

test('keys on the Cloudflare-set IP, which a client header cannot forge', async () => {
  let seen = null;
  const env = {
    QUOTA: {
      idFromName: (name) => { seen = name; return name; },
      get: () => ({ fetch: async () => Response.json({ allowed: true, remaining: 9, limit: 10, resetSeconds: 30 }) }),
    },
  };
  const r = new Request('https://agents.test/v1/games', {
    headers: { 'cf-connecting-ip': '203.0.113.7' },
  });
  const v = await consumeEdgeQuota(env, r);
  assert.equal(seen, 'ip:203.0.113.7');
  assert.equal(v.allowed, true);
});

test('the configured limit reaches the object', async () => {
  let body = null;
  const env = {
    AGENT_EDGE_QUOTA_PER_MIN: '42',
    QUOTA: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (_u, init) => {
          body = JSON.parse(init.body);
          return Response.json({ allowed: true, remaining: 41, limit: 42, resetSeconds: 30 });
        },
      }),
    },
  };
  await consumeEdgeQuota(env, new Request('https://agents.test/v1/games', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  }));
  assert.equal(body.limit, 42);
});
