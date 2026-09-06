/**
 * End-to-end smoke test for the Clubhouse Agent Protocol paper environment.
 *
 * Two agents, two real keypairs, one full game of chess played through the
 * actual stack: agent → gateway → wallet-signature auth → signed HMAC envelope
 * → private origin → MySQL. Nothing is mocked and nothing is called directly;
 * every request goes over HTTP through the gateway, exactly as a third-party
 * agent would make it.
 *
 * The point is not that chess works. It is that the seams hold: signing,
 * pairing, the trust boundary, the shared move core, settlement, and the audit
 * chain, in one continuous run.
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8799';

const log = (...a) => console.log(...a);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The challenge the gateway expects. Must match gateway/src/agentAuth.ts. */
function challengeString({ timestamp, nonce, method, path, bodyHash }) {
  return ['clubhouse-agent-v1', timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
}

let nonceCounter = 0;

/** One authenticated call, signed by the agent's own key. */
async function call(account, method, path, body) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = `${Date.now()}-${nonceCounter++}`;
  const message = challengeString({
    timestamp,
    nonce,
    method,
    path,
    bodyHash: sha256(rawBody),
  });
  const signature = await account.signMessage({ message });

  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-cap-agent-address': account.address,
      'x-cap-agent-timestamp': timestamp,
      'x-cap-agent-nonce': nonce,
      'x-cap-agent-signature': signature,
    },
    body: rawBody || undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, headers: res.headers };
}

function pick(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  // Checkmate if it is there, then the biggest capture, else the first legal
  // move. Deterministic on purpose: a failing run must be reproducible.
  const mate = moves.find((m) => m.san.includes('#'));
  if (mate) return mate;
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const captures = moves
    .filter((m) => m.captured)
    .sort((a, b) => (value[b.captured] ?? 0) - (value[a.captured] ?? 0));
  return captures[0] ?? moves[0];
}

async function main() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  log(`\nAgent A ${alice.address}`);
  log(`Agent B ${bob.address}\n`);

  // ── 1. Negative controls, before anything succeeds ─────────────────────────
  log('1. Trust boundary');
  {
    const res = await fetch(`${GATEWAY}/v1/chess/1`, {
      headers: { 'x-cap-agent-address': alice.address },
    });
    check('unsigned request is refused', res.status === 401, `got ${res.status}`);
  }
  {
    // A valid signature from Alice, replayed with Bob's address attached.
    const timestamp = String(Date.now());
    const nonce = `forge-${Date.now()}`;
    const message = challengeString({
      timestamp,
      nonce,
      method: 'GET',
      path: '/v1/chess/1',
      bodyHash: sha256(''),
    });
    const signature = await alice.signMessage({ message });
    const res = await fetch(`${GATEWAY}/v1/chess/1`, {
      headers: {
        'x-cap-agent-address': bob.address,
        'x-cap-agent-timestamp': timestamp,
        'x-cap-agent-nonce': nonce,
        'x-cap-agent-signature': signature,
      },
    });
    check('signature from one wallet cannot claim another', res.status === 401, `got ${res.status}`);
  }

  // ── 2. Paid entry (paper) ──────────────────────────────────────────────────
  log('\n2. Matchmaking');
  const joinA = await call(alice, 'POST', '/v1/matchmaking/chess', { variant: 'live' });
  check('agent A joins', joinA.status === 200, JSON.stringify(joinA.body));
  check('A is queued, not instantly matched', joinA.body.status === 'queued');
  check('paper mode is stamped on the response', joinA.body.paper === true);

  const joinB = await call(bob, 'POST', '/v1/matchmaking/chess', { variant: 'live' });
  check('agent B joins and is paired', joinB.body.status === 'matched', JSON.stringify(joinB.body));

  const matchId = joinB.body.matchId;
  check('a match id came back', Number.isInteger(matchId), String(matchId));
  if (!matchId) {
    log('\nNo match — stopping.');
    process.exit(1);
  }
  log(`  → match ${matchId}`);

  // Server-assigned pairing means neither agent chose the other. Confirm the
  // seat assignment came from the server rather than from the joiner.
  check('B took the joiner seat (p2)', joinB.body.seat === 'p2', String(joinB.body.seat));

  // ── 3. Access control on the match ─────────────────────────────────────────
  log('\n3. Match visibility');
  const stranger = privateKeyToAccount(generatePrivateKey());
  const peek = await call(stranger, 'GET', `/v1/chess/${matchId}`);
  check('a non-participant gets 404, not 403', peek.status === 404, `got ${peek.status}`);

  const viewA = await call(alice, 'GET', `/v1/chess/${matchId}`);
  check('participant can read the board', viewA.status === 200, JSON.stringify(viewA.body));
  check('A is white and to move', viewA.body.colour === 'white' && viewA.body.yourMove === true,
    `colour=${viewA.body.colour} yourMove=${viewA.body.yourMove}`);

  // ── 4. Illegal move is refused by the server ───────────────────────────────
  log('\n4. Server authority');
  const illegal = await call(alice, 'POST', `/v1/chess/${matchId}/move`, {
    action: 'move', from: 'e2', to: 'e5',
  });
  check('an illegal move is rejected', illegal.status === 400, JSON.stringify(illegal.body));

  const outOfTurn = await call(bob, 'POST', `/v1/chess/${matchId}/move`, {
    action: 'move', from: 'e7', to: 'e5',
  });
  check('moving out of turn is rejected', outOfTurn.status === 400, JSON.stringify(outOfTurn.body));

  // ── 5. Play it out ─────────────────────────────────────────────────────────
  log('\n5. Playing the game');
  const chess = new Chess();
  const seats = { white: alice, black: bob };
  let plies = 0;
  let terminal = null;
  let reason = null;
  const MAX_PLIES = 300;

  while (plies < MAX_PLIES) {
    if (chess.isGameOver()) break;
    const mover = chess.turn() === 'w' ? seats.white : seats.black;
    const move = pick(chess);
    if (!move) break;

    const res = await call(mover, 'POST', `/v1/chess/${matchId}/move`, {
      action: 'move',
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });

    if (res.status !== 200) {
      check(`move ${plies + 1} (${move.san}) accepted`, false, JSON.stringify(res.body));
      break;
    }

    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    plies++;

    if (res.body.terminal) {
      terminal = res.body.terminal;
      reason = res.body.reason;
      break;
    }
    if (plies % 20 === 0) log(`  … ${plies} plies`);
  }

  log(`  → ${plies} plies played`);

  // If the heuristic ran long without a finish, end it deliberately: resign is
  // a settlement path too, and an unsettled match proves nothing.
  if (!terminal) {
    log('  … no natural finish, resigning to exercise settlement');
    const mover = chess.turn() === 'w' ? seats.white : seats.black;
    const res = await call(mover, 'POST', `/v1/chess/${matchId}/move`, { action: 'resign' });
    terminal = res.body.terminal;
    reason = res.body.reason;
  }

  check('the game reached a terminal state', Boolean(terminal), `${terminal} (${reason})`);

  // ── 6. Settlement ──────────────────────────────────────────────────────────
  log('\n6. Settlement');
  const finalView = await call(alice, 'GET', `/v1/chess/${matchId}`);
  check('match is completed', finalView.body.status === 'completed', String(finalView.body.status));
  check('a result was recorded', Boolean(finalView.body.result), String(finalView.body.result));

  const moveAfterEnd = await call(alice, 'POST', `/v1/chess/${matchId}/move`, {
    action: 'move', from: 'a2', to: 'a3',
  });
  check('a finished match rejects further moves', moveAfterEnd.status === 409,
    `got ${moveAfterEnd.status}`);

  // ── 7. The ladder ──────────────────────────────────────────────────────────
  log('\n7. Leaderboard');
  const board = await fetch(`${GATEWAY}/v1/leaderboards/chess`).then((r) => r.json());
  check('board is on the settlement chain', board.chain === 'base-sepolia', String(board.chain));
  const wallets = (board.entries ?? []).map((e) => e.wallet);
  check('both agents appear', wallets.includes(alice.address) && wallets.includes(bob.address),
    JSON.stringify(wallets));
  check('they are labelled as agents',
    (board.entries ?? []).every((e) => e.class === 'agent'),
    JSON.stringify((board.entries ?? []).map((e) => e.class)));

  log('\n' + '─'.repeat(60));
  if (failures.length) {
    log(`FAILED — ${failures.length} check(s):`);
    failures.forEach((f) => log(`  • ${f}`));
    process.exit(1);
  }
  log(`PASSED — full game settled in ${plies} plies (${terminal}, ${reason})`);
  log(`match ${matchId} · agents ${alice.address.slice(0, 10)} / ${bob.address.slice(0, 10)}`);
}

main().catch((e) => {
  console.error('\nSMOKE TEST CRASHED:', e);
  process.exit(1);
});
