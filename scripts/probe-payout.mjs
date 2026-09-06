/**
 * The payout path, end to end.
 *
 * Plays a real game, then checks that the winner is credited, that the credit
 * is claimable, and — most importantly — that none of it can be double-counted.
 * "Play for real money" was one-directional until this existed: fees collected,
 * nothing ever paid back.
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Chess } from 'chess.js';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8799';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const chal = (p) => ['clubhouse-agent-v1', p.timestamp, p.nonce, p.method, p.path, p.bodyHash].join('\n');

let n = 0;
async function call(a, method, path, body) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = `${Date.now()}-${n++}-${Math.floor(Math.random() * 1e9)}`;
  const signature = await a.signMessage({
    message: chal({ timestamp, nonce, method, path, bodyHash: sha256(rawBody) }),
  });
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-cap-agent-address': a.address,
      'x-cap-agent-timestamp': timestamp,
      'x-cap-agent-nonce': nonce,
      'x-cap-agent-signature': signature,
    },
    body: rawBody || undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sql = (q) => {
  const out = execSync(
    `docker exec cap-paper-mysql mysql -uroot -ppaper -N -B --skip-pager -e ${JSON.stringify(q)} 2>/dev/null`,
  ).toString().trim().split('\n');
  return out[out.length - 1].trim();
};

const results = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  results.push(ok);
};

function pick(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const mate = moves.find((m) => m.san.includes('#'));
  if (mate) return mate;
  const v = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  return moves.filter((m) => m.captured).sort((a, b) => (v[b.captured] ?? 0) - (v[a.captured] ?? 0))[0] ?? moves[0];
}

console.log('\nPayout path\n');

sql(`UPDATE rjctd_clubhouse_base.game_match_queue SET status='cancelled' WHERE status='waiting'`);

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

const a1 = await call(alice, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
const b1 = await call(bob, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
const matchId = b1.body.matchId;
check('two agents seated', a1.status === 200 && b1.body.status === 'matched', `match ${matchId}`);

// Play to a finish.
const chess = new Chess();
const seats = { white: alice, black: bob };
let terminal = null;
for (let i = 0; i < 300 && !chess.isGameOver(); i++) {
  const mover = chess.turn() === 'w' ? seats.white : seats.black;
  const mv = pick(chess);
  if (!mv) break;
  const r = await call(mover, 'POST', `/v1/chess/${matchId}/move`, {
    action: 'move', from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}),
  });
  if (r.status !== 200) { check(`move ${i + 1} accepted`, false, JSON.stringify(r.body)); break; }
  chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  if (r.body.terminal) { terminal = r.body.terminal; break; }
}
check('game reached a result', Boolean(terminal), String(terminal));

const winner = terminal === 'p1' ? alice : bob;
const loser = terminal === 'p1' ? bob : alice;

// ── The money ──────────────────────────────────────────────────────────────
const pot = sql(`SELECT CONCAT(entries_base,'|',rake_base,'|',credited_base)
                   FROM rjctd_clubhouse_base.agent_match_pots WHERE match_id=${matchId}`);
const [entries, rake, credited] = pot.split('|').map(Number);
check('pot conserves money', entries === rake + credited, `${entries} = ${rake} + ${credited}`);
check('rake is 5%', rake === entries * 0.05, `rake ${rake} of ${entries}`);

const claims = await call(winner, 'GET', '/v1/claims');
check('winner sees a claim', claims.status === 200 && claims.body.claims?.length > 0,
  JSON.stringify(claims.body.unpaidTotal));

const loserClaims = await call(loser, 'GET', '/v1/claims');
check('loser is owed nothing', (loserClaims.body.claims ?? []).length === 0,
  `${(loserClaims.body.claims ?? []).length} claims`);

const claimId = claims.body.claims?.[0]?.claimId;
check('credit equals pot minus rake', Number(claims.body.claims?.[0]?.amount) * 1e6 === credited,
  `${claims.body.claims?.[0]?.amount}`);

// ── Nobody else's money ────────────────────────────────────────────────────
const thief = privateKeyToAccount(generatePrivateKey());
const steal = await call(thief, 'POST', `/v1/claims/${claimId}/claim`);
check("a stranger cannot claim someone else's winnings", steal.status === 404, `got ${steal.status}`);

// ── Settling twice must not credit twice ───────────────────────────────────
const before = sql(`SELECT COUNT(*) FROM rjctd_clubhouse_base.reward_claims
                     WHERE source='agent_match' AND source_ref_id=${matchId}`);
await call(winner, 'POST', `/v1/chess/${matchId}/move`, { action: 'resign' });
const after = sql(`SELECT COUNT(*) FROM rjctd_clubhouse_base.reward_claims
                    WHERE source='agent_match' AND source_ref_id=${matchId}`);
check('a finished match cannot be credited again', before === after, `${before} then ${after}`);

const pots = sql(`SELECT COUNT(*) FROM rjctd_clubhouse_base.agent_match_pots WHERE match_id=${matchId}`);
check('exactly one pot per match', pots === '1', `${pots} pots`);

// ── The send itself ────────────────────────────────────────────────────────
// No funded pot wallet in the paper environment, so this MUST fail — and must
// fail without marking the claim paid. A payout that reports success without
// moving money is the worst possible outcome, so the failure path matters more
// than the happy one here.
const paid = await call(winner, 'POST', `/v1/claims/${claimId}/claim`);
const stillUnpaid = sql(`SELECT payout_tx IS NULL FROM rjctd_clubhouse_base.reward_claims WHERE id=${claimId}`);
check('an unfunded payout fails rather than lying', paid.status >= 400, `got ${paid.status}`);
check('a failed payout leaves the claim unpaid and retryable', stillUnpaid === '1',
  `payout_tx null: ${stillUnpaid}`);
const lockFree = sql(`SELECT claim_in_flight FROM rjctd_clubhouse_base.reward_claims WHERE id=${claimId}`);
check('the CAS lock is released after failure', lockFree === '0', `claim_in_flight=${lockFree}`);

console.log('');
process.exit(results.every(Boolean) ? 0 : 1);
