/**
 * A stand-in for the private origin, so this repo can be run and attacked
 * without it.
 *
 * ## Why this exists
 *
 * The security-critical surface of the agent protocol is the trust boundary:
 * the HMAC envelope the gateway signs and the origin verifies. That is what a
 * bug bounty most wants someone hammering. But the origin lives in a private
 * repository, so until now the only complete path a researcher could reach was
 * PRODUCTION, with real USDC in it — and the paper-environment guide told them
 * to run something they had no way to obtain.
 *
 * This is the verification half, reimplemented from the published contract
 * rather than copied from the private code. It is deliberately independent: if
 * this and the real origin ever disagree about what a valid envelope is, that
 * disagreement is itself a finding worth reporting.
 *
 * Everything behind the boundary is canned. There is no database, no money and
 * no game engine — those are not what this is for.
 *
 *   node scripts/mock-origin.mjs            # listens on 8788
 *   PORT=9000 node scripts/mock-origin.mjs
 */

import { createServer } from 'node:http';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8788);
const SECRET = process.env.AGENT_GATEWAY_HMAC_SECRET ?? '';

if (SECRET.length < 32) {
  console.error(
    'AGENT_GATEWAY_HMAC_SECRET must be at least 32 bytes.\n' +
      'The real origin fails closed on a short or missing secret rather than\n' +
      'accepting unsigned requests, and so does this.',
  );
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The canonical string. Order and the newline separator are the contract; the
 * separator is load-bearing, because without it ("ab","c") and ("a","bc")
 * produce identical material and a crafted path could impersonate another.
 */
function canonicalString(p) {
  return [
    p.timestamp, p.nonce, p.method, p.path, p.bodyHash, p.wallet, p.chainId, p.paymentHash,
  ].join('\n');
}

function constantTimeEquals(a, b) {
  const ab = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self so a length mismatch costs the same time as a
    // content mismatch — the throw from timingSafeEqual is itself an oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const MAX_SKEW_MS = 30_000;
/** Replay guard. In-memory here; the real origin uses Redis across a cluster. */
const seenNonces = new Map();

function verify(req, rawBody, url) {
  const h = (n) => req.headers[n] ?? '';
  const signature = h('x-cap-signature');
  const timestamp = h('x-cap-timestamp');
  const nonce = h('x-cap-nonce');
  const wallet = h('x-cap-wallet');
  const chainId = h('x-chain-id');
  const paymentJson = h('x-cap-payment');

  if (!signature || !timestamp || !nonce) return { ok: false, why: 'missing_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, why: 'bad_timestamp' };
  // Bounded BOTH ways: a far-future timestamp would otherwise let a captured
  // envelope be held until its nonce expired, then replayed.
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { ok: false, why: 'stale' };

  const path = url.pathname.replace(/^\/api\/internal\/agent\/v1/, '') + (url.search || '');

  const expected = createHmac('sha256', SECRET)
    .update(
      canonicalString({
        timestamp, nonce,
        method: req.method,
        path,
        bodyHash: sha256(rawBody),
        wallet,
        chainId,
        paymentHash: paymentJson ? sha256(paymentJson) : '',
      }),
      'utf8',
    )
    .digest('hex');

  if (!constantTimeEquals(signature, expected)) return { ok: false, why: 'bad_signature' };

  // Only AFTER the signature holds. Claiming a nonce before verifying would let
  // an unauthenticated caller burn other agents' nonces.
  const now = Date.now();
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
  if (seenNonces.has(nonce)) return { ok: false, why: 'replayed' };
  seenNonces.set(nonce, now + 60_000);

  return { ok: true, wallet, chainId, path, payment: paymentJson ? JSON.parse(paymentJson) : null };
}

const send = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://localhost:${PORT}`);

    const v = verify(req, rawBody, url);
    if (!v.ok) {
      console.log(`  ✗ ${req.method} ${url.pathname} → ${v.why}`);
      // Vague to the caller, specific in the log: telling an attacker whether a
      // signature was wrong or merely replayed helps them tune.
      const status = v.why === 'not_configured' ? 503 : 401;
      return send(res, status, { error: 'Unauthorized' });
    }

    console.log(`  ✓ ${req.method} ${v.path}  wallet=${v.wallet || 'anon'} chain=${v.chainId || '-'}`);

    // ── Canned responses. No database, no money, no game engine. ───────────
    if (v.path.startsWith('/status')) {
      return send(res, 200, {
        mock: true, paperMode: true,
        chains: [{ chain: 'base-sepolia', acceptingEntries: true, missing: [] }],
        note: 'Mock origin. Nothing here settles, scores, or pays.',
      });
    }
    if (v.path.startsWith('/games')) {
      return send(res, 200, { mock: true, games: [{ game: 'chess', status: 'open' }] });
    }
    if (v.path.startsWith('/leaderboards')) {
      return send(res, 200, { mock: true, game: 'chess', entries: [] });
    }
    if (v.path.startsWith('/matchmaking/')) {
      if (!v.payment) return send(res, 402, { error: 'Payment required', mock: true });
      return send(res, 200, { mock: true, status: 'queued', queueId: 1, paidNonce: v.payment.nonce });
    }
    if (/^\/chess\/\d+$/.test(v.path)) {
      return send(res, 200, {
        mock: true, matchId: 1, status: 'active', seat: 'p1', colour: 'white', yourMove: true,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      });
    }
    if (/^\/chess\/\d+\/move$/.test(v.path)) {
      return send(res, 200, { mock: true, matchId: 1, terminal: null });
    }
    return send(res, 404, { error: 'Not found', mock: true, path: v.path });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock origin on http://127.0.0.1:${PORT}`);
  console.log('verifying envelopes with the configured secret; everything behind it is canned.\n');
});
