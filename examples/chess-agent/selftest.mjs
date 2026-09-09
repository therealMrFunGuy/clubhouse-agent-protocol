#!/usr/bin/env node
/**
 * Play a whole match against a local stand-in for the gateway.
 *
 *   npm install && npm run selftest
 *
 * ## Why this exists
 *
 * Every other way of checking this agent costs 0.50 USDC and needs a live
 * opponent, so "does it work?" was answered by reading it. It was not working:
 * it sent no signature, tested the queue's status against a value the queue
 * never returns, read `match.id` from a response whose field is `matchId`, and
 * branched on a `yourTurn` flag that exists nowhere in the API.
 *
 * Each of those is invisible to a type checker and obvious to a server. So the
 * server is the test: this file stands up the four routes the agent calls,
 * verifies the wallet signature on every one of them exactly as
 * gateway/src/agentAuth.ts does, and plays a real game of chess back. Nothing
 * is mocked at the seam that broke — the agent runs unmodified, as a child
 * process, against a socket.
 *
 * It is not a substitute for a real match. It cannot tell you that the live
 * gateway agrees with this file; only that the agent and the protocol as
 * documented agree with each other.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Chess } from 'chess.js';

/** How long the stub opponent thinks. Long enough that the agent really blocks. */
const OPPONENT_MS = 25;
/** Stop a random game that will not end on its own. */
const PLY_CAP = 160;

const agentKey = `0x${randomBytes(32).toString('hex')}`;
const agentAddress = privateKeyToAccount(agentKey).address;

const stats = { signed: 0, unsigned: 0, badSignature: 0, agentMoves: 0 };

// ── The verifying half, copied from the gateway ─────────────────────────────

async function verify(req, rawBody) {
  const address = req.headers['x-cap-agent-address'];
  const timestamp = req.headers['x-cap-agent-timestamp'];
  const nonce = req.headers['x-cap-agent-nonce'];
  const signature = req.headers['x-cap-agent-signature'];
  if (!address || !timestamp || !nonce || !signature) {
    stats.unsigned++;
    return { ok: false, why: 'missing headers' };
  }
  if (Math.abs(Date.now() - Number(timestamp)) > 30_000) {
    return { ok: false, why: 'stale timestamp' };
  }

  // GET bodies are hashed as empty by the gateway, whatever was sent.
  const body = req.method === 'GET' ? '' : rawBody;
  const message = [
    'clubhouse-agent-v1',
    timestamp,
    nonce,
    req.method.toUpperCase(),
    req.url, // path INCLUDING the query string
    createHash('sha256').update(body, 'utf8').digest('hex'),
  ].join('\n');

  const valid = await verifyMessage({ address, message, signature }).catch(() => false);
  if (!valid) {
    stats.badSignature++;
    return { ok: false, why: 'bad signature' };
  }
  if (address.toLowerCase() !== agentAddress.toLowerCase()) {
    return { ok: false, why: 'signed by an unexpected wallet' };
  }
  stats.signed++;
  return { ok: true };
}

// ── The match ──────────────────────────────────────────────────────────────

const board = new Chess();
const match = { id: 4242, status: 'active', result: null, moves: [] };
let paired = false; // flips once the agent has polled /v1/matches/mine

function chessState() {
  return {
    variant: 'live',
    fen: board.fen(),
    moves: match.moves,
    white: 'p1',
    clock: { p1Ms: 300_000, p2Ms: 300_000 },
    turnStartAt: Date.now(),
    startedAt: Date.now(),
    drawOffer: null,
  };
}

function versionOf() {
  return createHash('sha256')
    .update(`${match.status}\n${match.result ?? ''}\n${JSON.stringify(chessState())}`)
    .digest('hex')
    .slice(0, 16);
}

function settle(result, reason) {
  match.status = 'finished';
  match.result = result;
  match.reason = reason;
}

/** The opponent: a random legal move, after a beat. */
function opponentReplies() {
  setTimeout(() => {
    if (match.status !== 'active' || board.turn() !== 'b') return;
    const moves = board.moves({ verbose: true });
    if (!moves.length) return settle(board.isCheckmate() ? 'p1' : 'draw', 'no legal moves');
    const m = moves[Math.floor(Math.random() * moves.length)];
    board.move(m);
    match.moves.push(m.san);
    if (board.isGameOver()) {
      settle(board.isCheckmate() ? 'p2' : 'draw', 'game over');
    } else if (match.moves.length >= PLY_CAP) {
      settle('draw', 'selftest ply cap');
    }
  }, OPPONENT_MS);
}

// ── The four routes ────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const auth = await verify(req, raw);
  if (!auth.ok) return send(401, { error: 'Unauthorized', detail: auth.why });

  const [path] = req.url.split('?');
  const query = new URLSearchParams(req.url.split('?')[1] ?? '');
  const body = raw ? JSON.parse(raw) : {};

  // Queued, not matched — the harder of the two answers, and the one the old
  // agent could not handle. matchId is null here by design.
  if (req.method === 'POST' && path === '/v1/matchmaking/queue') {
    if (body.game !== 'chess') return send(400, { error: 'Unknown game' });
    return send(200, {
      status: 'queued',
      game: 'chess',
      matchId: null,
      queueId: 7,
      seat: null,
      variant: body.variant ?? 'live',
      pairingNote: null,
    });
  }

  if (req.method === 'GET' && path === '/v1/matches/mine') {
    paired = true;
    return send(200, {
      wallet: agentAddress,
      chain: 'base-mainnet',
      count: 1,
      awaitingYou: board.turn() === 'w' ? [match.id] : [],
      matches: [
        {
          matchId: match.id,
          game: 'chess',
          variant: 'live',
          status: match.status,
          seat: 'p1',
          opponent: '0x' + '11'.repeat(20),
          yourMove: board.turn() === 'w',
          result: match.result,
          winner: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  }

  if (req.method === 'GET' && path === `/v1/chess/${match.id}`) {
    if (!paired) return send(404, { error: 'Match not found' });
    return send(200, {
      matchId: match.id,
      status: match.status,
      variant: 'live',
      seat: 'p1',
      colour: 'white',
      yourMove: board.turn() === 'w' && match.status === 'active',
      fen: board.fen(),
      moves: match.moves,
      drawOffer: null,
      clocks: { p1Ms: 300_000, p2Ms: 300_000, turnStartAt: Date.now() },
      opponent: '0x' + '11'.repeat(20),
      result: match.result,
      winner: null,
    });
  }

  if (req.method === 'GET' && path === `/v1/matches/${match.id}/events`) {
    const since = query.get('since');
    const wait = Math.min(25, Number(query.get('wait') ?? 25));
    const deadline = Date.now() + wait * 1000;
    let version = versionOf();
    while (since && version === since && match.status === 'active' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      version = versionOf();
    }
    return send(200, {
      matchId: match.id,
      game: 'chess',
      status: match.status,
      result: match.result,
      winner: null,
      p1: agentAddress,
      p2: '0x' + '11'.repeat(20),
      state: chessState(),
      version,
      timedOut: Boolean(since) && version === since && match.status === 'active',
      keepWaiting: match.status === 'active',
    });
  }

  if (req.method === 'POST' && path === `/v1/chess/${match.id}/move`) {
    if (body.action === 'claim_flag') {
      return send(400, { error: 'There is still time on that clock' });
    }
    if (body.action !== 'move') return send(400, { error: 'Unknown action' });
    if (match.status !== 'active') return send(409, { error: 'Match is over' });
    if (board.turn() !== 'w') return send(400, { error: 'Not your turn' });

    let played;
    try {
      played = board.move({ from: body.from, to: body.to, promotion: body.promotion });
    } catch {
      return send(400, { error: `Illegal move ${body.from}${body.to}` });
    }
    match.moves.push(played.san);
    stats.agentMoves++;

    if (board.isGameOver()) {
      settle(board.isCheckmate() ? 'p1' : 'draw', 'game over');
    } else if (match.moves.length >= PLY_CAP) {
      settle('draw', 'selftest ply cap');
    } else {
      opponentReplies();
    }

    return send(200, {
      matchId: match.id,
      terminal: match.status === 'finished' ? match.result : null,
      reason: match.reason ?? null,
      ratingDeltas: null,
    });
  }

  return send(404, { error: 'Unknown endpoint', path });
});

// ── Run the real agent against it ───────────────────────────────────────────

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
console.log(`stub gateway on ${url}\n`);

const child = spawn(process.execPath, ['agent.mjs'], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    CLUBHOUSE_API_URL: url,
    CLUBHOUSE_AGENT_PRIVATE_KEY: agentKey,
  },
  stdio: 'inherit',
});

const code = await new Promise((resolve) => child.on('exit', resolve));
server.close();

console.log(
  `\nsigned requests ${stats.signed}, unsigned ${stats.unsigned}, ` +
    `bad signatures ${stats.badSignature}, agent moves ${stats.agentMoves}, ` +
    `result ${match.result ?? 'unfinished'} (${match.reason ?? '—'})`,
);

const failures = [];
if (code !== 0) failures.push(`agent exited ${code}`);
if (stats.unsigned) failures.push(`${stats.unsigned} request(s) carried no signature`);
if (stats.badSignature) failures.push(`${stats.badSignature} signature(s) did not verify`);
if (stats.agentMoves < 2) failures.push(`agent completed only ${stats.agentMoves} move(s)`);
if (match.status !== 'finished') failures.push('match never reached a result');

if (failures.length) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: signed every request, played the match through to a result.');
