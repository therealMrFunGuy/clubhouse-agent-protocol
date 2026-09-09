#!/usr/bin/env node
/**
 * Play a rack against a local stand-in for the gateway.
 *
 *   npm install && npm run selftest
 *
 * ## Why this exists
 *
 * Checking this agent any other way costs 0.50 USDC and needs a live opponent,
 * so "does it work?" used to be answered by reading it — and reading it missed
 * that it sent no wallet signature, that it compared the queue's status against
 * a value the queue never returns, that it read `match.id` from a response
 * whose field is `matchId`, that it branched on a `yourTurn` flag that exists
 * nowhere in this API, and that it filtered balls on `pocketed` when the stored
 * field is `pk` — so every pocketed ball stayed on its imaginary table.
 *
 * So the server is the test. This file stands up the routes the agent calls,
 * verifies the signature on each exactly as gateway/src/agentAuth.ts does, and
 * runs the SAME engine the real server runs to judge the shots that come back.
 * The agent runs unmodified, as a child process, against a socket.
 *
 * It cannot tell you the live gateway agrees with this file — only that the
 * agent and the protocol as documented agree with each other.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { initPoolState, applyShot } from '@goclubhouse/pool-sim';

const GAME = 'pool8';
/**
 * The agent sits in p2 on purpose. p1 breaks, and an 8 on the break is a legal
 * win under the bar rule the engine implements — the agent finds that shot on
 * its first search, wins in one, and the turn loop never runs. Seating it
 * second also exercises the seat the queue assigns rather than the one an
 * example would assume.
 */
const AGENT_SEAT = 'p2';
const OPPONENT_SEAT = 'p1';
/** The stub opponent's thinking time — long enough that the agent really blocks. */
const OPPONENT_MS = 40;
/** Bound the rack. A random opponent will not always find the 8. */
const SHOT_CAP = 24;

const agentKey = `0x${randomBytes(32).toString('hex')}`;
const agentAddress = privateKeyToAccount(agentKey).address;

const stats = { signed: 0, unsigned: 0, badSignature: 0, agentShots: 0, agentFouls: 0 };

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
  if (Math.abs(Date.now() - Number(timestamp)) > 30_000) return { ok: false, why: 'stale' };

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
  stats.signed++;
  return { ok: true };
}

// ── The match, run on the real engine ──────────────────────────────────────

const match = { id: 909, status: 'active', result: null, shots: 0 };
let state = initPoolState(GAME, Date.now());

function versionOf() {
  return createHash('sha256')
    .update(`${match.status}\n${match.result ?? ''}\n${JSON.stringify(state)}`)
    .digest('hex')
    .slice(0, 16);
}

function settle(result, reason) {
  match.status = 'finished';
  match.result = result;
  match.reason = reason;
}

/** Commit a judged shot and advance the game, the way the server's core does. */
function commit(played) {
  state = played.state;
  match.shots++;
  if (played.result) settle(played.result, played.reason ?? 'game over');
  else if (match.shots >= SHOT_CAP) settle('draw', 'selftest shot cap');
  else if (state.turn === OPPONENT_SEAT) opponentShoots();
}

const randomShot = () => ({
  angle: Math.random() * Math.PI * 2,
  power: 0.3 + Math.random() * 0.6,
  spinSide: 0,
  spinVert: 0,
});

/** The opponent: a random shot, after a beat. */
function opponentShoots() {
  setTimeout(() => {
    if (match.status !== 'active' || state.turn !== OPPONENT_SEAT) return;
    for (let attempt = 0; attempt < 40; attempt++) {
      const played = applyShot(state, OPPONENT_SEAT, randomShot(), Date.now());
      if (!played.ok) continue;
      // A rack the opponent ends before the agent has moved tests nothing.
      // applyShot copies, so discarding a candidate costs only the attempt.
      if (played.result && stats.agentShots === 0) continue;
      return commit(played);
    }
    settle(AGENT_SEAT, 'opponent found no shot to take');
  }, OPPONENT_MS);
}

// ── Routes ─────────────────────────────────────────────────────────────────

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

  // Matched straight away — the chess selftest covers the `queued` answer.
  if (req.method === 'POST' && path === '/v1/matchmaking/queue') {
    if (body.game !== GAME) return send(400, { error: 'Unknown game' });
    // p1 is already on the table; the agent joins as p2 and waits for the break.
    opponentShoots();
    return send(200, {
      status: 'matched',
      game: GAME,
      matchId: match.id,
      queueId: null,
      seat: AGENT_SEAT,
      variant: 'live',
      pairingNote: null,
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
      game: GAME,
      status: match.status,
      result: match.result,
      winner: null,
      p1: agentAddress,
      p2: '0x' + '11'.repeat(20),
      state, // pool is perfect information, so the waiter serves it raw
      version,
      timedOut: Boolean(since) && version === since && match.status === 'active',
      keepWaiting: match.status === 'active',
    });
  }

  if (req.method === 'POST' && path === `/v1/pool/${match.id}/shot`) {
    if (body.action === 'claim_timeout') {
      return send(400, { error: 'There is still time on that clock' });
    }
    if (body.action !== 'shot') return send(400, { error: 'Unknown action' });
    if (match.status !== 'active') return send(409, { error: 'Match is over' });
    if (state.turn !== AGENT_SEAT) return send(400, { error: 'Not your turn' });

    const played = applyShot(
      state,
      AGENT_SEAT,
      { angle: body.angle, power: body.power, spinSide: body.spinSide, spinVert: body.spinVert },
      Date.now(),
    );
    if (!played.ok) return send(400, { error: played.error });

    stats.agentShots++;
    if (played.state?.lastShot?.foul) stats.agentFouls++;
    commit(played);

    return send(200, {
      matchId: match.id,
      frames: null, // the real route returns these; nothing here reads them
      terminal: match.status === 'finished' ? match.result : null,
      reason: match.reason ?? null,
      ratingDeltas: null,
    });
  }

  return send(404, { error: 'Unknown endpoint', path });
});

// ── Run the real agent against it ──────────────────────────────────────────

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
console.log(`stub gateway on ${url}\n`);

const child = spawn(process.execPath, ['agent.mjs'], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    CLUBHOUSE_API_URL: url,
    CLUBHOUSE_AGENT_PRIVATE_KEY: agentKey,
    GAME,
    // A narrow search so a whole rack finishes in seconds. The default 240 is
    // ~5s per turn, which is right for a match and wrong for a test.
    ANGLE_STEPS: '24',
  },
  stdio: 'inherit',
});

const code = await new Promise((resolve) => child.on('exit', resolve));
server.close();

console.log(
  `\nsigned requests ${stats.signed}, unsigned ${stats.unsigned}, ` +
    `bad signatures ${stats.badSignature}, agent shots ${stats.agentShots} ` +
    `(${stats.agentFouls} fouls), result ${match.result ?? 'unfinished'} (${match.reason ?? '—'})`,
);

const failures = [];
if (code !== 0) failures.push(`agent exited ${code}`);
if (stats.unsigned) failures.push(`${stats.unsigned} request(s) carried no signature`);
if (stats.badSignature) failures.push(`${stats.badSignature} signature(s) did not verify`);
if (stats.agentShots < 2) failures.push(`agent took only ${stats.agentShots} shot(s)`);
if (match.status !== 'finished') failures.push('match never reached a result');

if (failures.length) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: signed every request, played the rack through to a result.');
