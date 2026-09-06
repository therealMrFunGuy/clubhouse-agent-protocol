/**
 * Reachability probe: does every advertised endpoint actually answer?
 *
 * An audit curled the published surface and found 2 of 14 specified operations
 * responding — the rest returned Next.js HTML 404s under a JSON content type,
 * so a conforming client crashed on parse rather than seeing a 404. The spec,
 * the README, llms.txt, the MCP server and both example agents all described a
 * system that did not answer.
 *
 * This script exists so that can never again be discovered by an outsider
 * first. It asserts reachability, not correctness — a 200 here means the door
 * opens, and the smoke test proves what is behind it.
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createHash } from 'node:crypto';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8799';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const chal = (p) =>
  ['clubhouse-agent-v1', p.timestamp, p.nonce, p.method, p.path, p.bodyHash].join('\n');

let n = 0;
async function call(account, method, path, body) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = `${Date.now()}-${n++}-${Math.floor(Math.random() * 1e9)}`;
  const headers = { 'content-type': 'application/json' };
  if (account) {
    headers['x-cap-agent-address'] = account.address;
    headers['x-cap-agent-timestamp'] = timestamp;
    headers['x-cap-agent-nonce'] = nonce;
    headers['x-cap-agent-signature'] = await account.signMessage({
      message: chal({ timestamp, nonce, method, path, bodyHash: sha256(rawBody) }),
    });
  }
  const res = await fetch(`${GATEWAY}${path}`, { method, headers, body: rawBody || undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — that is itself a finding */ }
  return { status: res.status, json, isJson: json !== null, text };
}

const rows = [];
const record = (op, status, ok, note = '') => {
  rows.push({ op, status, ok, note });
  console.log(`  ${ok ? '✓' : '✗'} ${String(status).padEnd(3)}  ${op}${note ? `  — ${note}` : ''}`);
};

async function main() {
  const agent = privateKeyToAccount(generatePrivateKey());
  console.log('\nAdvertised surface — does it answer?\n');

  // Seat the agent so the "mine"/match probes have something real to read.
  const join = await call(agent, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
  record('POST /v1/matchmaking/queue', join.status, join.status === 200);

  const checks = [
    ['GET  /v1/games', () => call(null, 'GET', '/v1/games'), (r) => r.status === 200 && Array.isArray(r.json?.games)],
    ['GET  /v1/leaderboards/{game}', () => call(null, 'GET', '/v1/leaderboards/chess'), (r) => r.status === 200],
    ['GET  /v1/agents/{wallet}', () => call(null, 'GET', `/v1/agents/${agent.address}?chain=base-sepolia`), (r) => r.status === 200],
    ['GET  /v1/matches/mine', () => call(agent, 'GET', '/v1/matches/mine'), (r) => r.status === 200 && Array.isArray(r.json?.matches)],
    ['GET  /v1/audit/{wallet}', () => call(agent, 'GET', `/v1/audit/${agent.address}`), (r) => r.status === 200 && r.json?.selfCheck?.valid === true],
    ['POST /v1/matchmaking/chess/cancel', () => call(agent, 'POST', '/v1/matchmaking/chess/cancel'), (r) => r.status === 200],
  ];

  for (const [op, run, ok] of checks) {
    const r = await run();
    let note = '';
    if (!r.isJson) note = 'NOT JSON — a client would crash on parse';
    record(op, r.status, ok(r) && r.isJson, note);
  }

  // Reading someone else's chain must be refused — the gateway defers this
  // check entirely to the origin, so it is the only thing enforcing it.
  const other = privateKeyToAccount(generatePrivateKey());
  const cross = await call(agent, 'GET', `/v1/audit/${other.address}`);
  record("GET  /v1/audit/{someone else's}", cross.status, cross.status === 403, 'must be refused');

  // Still-unbuilt operations must say so honestly rather than 404 as HTML.
  console.log('\nNot built yet — should be visible as such, not as a crash:\n');
  const pool = await call(agent, 'POST', '/v1/matchmaking/queue', { game: 'pool8' });
  record('POST /v1/matchmaking/queue {pool8}', pool.status,
    pool.status === 501 && pool.isJson, 'declared "planned" in /v1/games');

  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`${rows.length - failed.length}/${rows.length} advertised operations answer.`);
  if (failed.length) {
    console.log(`STILL DEAD: ${failed.map((f) => f.op).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
