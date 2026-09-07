/**
 * A real game, on Base mainnet, with real USDC.
 *
 * Two agents pay a $1.00 entry fee through x402, are paired by the server, play
 * a full game of chess, and the winner claims the pot. Nothing here is
 * simulated: the payments settle on-chain, the payout is an ERC-20 transfer,
 * and every request goes over the public internet through
 * agents.goclubhouse.io exactly as a third-party agent's would.
 *
 * Keys are read from ~/.config/clubhouse/agent-test-wallets.json and never
 * printed.
 *
 * Usage:
 *   node scripts/live-game.mjs              # play a full game
 *   node scripts/live-game.mjs --probe      # just pay one entry, no game
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, publicActions } from 'viem';
import { base } from 'viem/chains';
import { Chess } from 'chess.js';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

const GATEWAY = process.env.GATEWAY ?? 'https://agents.goclubhouse.io';
const RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org';

const wallets = JSON.parse(
  readFileSync(`${homedir()}/.config/clubhouse/agent-test-wallets.json`, 'utf8'),
);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const challenge = (p) =>
  ['clubhouse-agent-v1', p.timestamp, p.nonce, p.method, p.path, p.bodyHash].join('\n');

let nonceCounter = 0;

/** An agent: a wallet, an x402 payer, and a signer for free routes. */
function makeAgent(entry) {
  const account = privateKeyToAccount(entry.privateKey);
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) }).extend(
    publicActions,
  );

  // ClientEvmSigner wants a FLAT { address, signTypedData } — a viem wallet
  // client exposes `.account.address`, not `.address`, so handing the wallet
  // over directly makes the scheme read `undefined` as the payer and fail with
  // 'Address "undefined" is invalid'. Adapt rather than assume.
  const signer = {
    address: account.address,
    signTypedData: (m) => wallet.signTypedData({ account, ...m }),
    readContract: (a) => wallet.readContract(a),
  };

  // x402HTTPClient WRAPS an x402Client; the scheme registers on the inner one.
  // It provides the 402 primitives rather than a fetch wrapper, so the retry
  // below is driven explicitly.
  const inner = new x402Client();
  registerExactEvmScheme(inner, { signer });
  const pay = new x402HTTPClient(inner);

  return { name: entry.name, address: account.address, account, wallet, pay, inner };
}

/** Free, identified call: signs the challenge the gateway expects. */
async function call(agent, method, path, body) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = `${Date.now()}-${nonceCounter++}-${Math.floor(Math.random() * 1e9)}`;
  const signature = await agent.account.signMessage({
    message: challenge({ timestamp, nonce, method, path, bodyHash: sha256(rawBody) }),
  });
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-cap-agent-address': agent.address,
      'x-cap-agent-timestamp': timestamp,
      'x-cap-agent-nonce': nonce,
      'x-cap-agent-signature': signature,
    },
    body: rawBody || undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, body: json };
}

/**
 * Paid call: the explicit 402 → sign → retry dance.
 *
 * The first request is expected to be refused. That refusal carries the price,
 * the asset and the payee; the client signs an authorisation for exactly that
 * and retries. The signature moves USDC by EIP-3009 authorisation, so the agent
 * spends no gas — the facilitator submits the transaction.
 */
async function payAndCall(agent, path, body) {
  const url = `${GATEWAY}${path}`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };

  const first = await fetch(url, init);
  if (first.status !== 402) {
    const text = await first.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    return { status: first.status, body: json, settlement: null, paid: false };
  }

  const required = agent.pay.getPaymentRequiredResponse((n) => first.headers.get(n));

  // Build and encode explicitly rather than via handlePaymentRequired(), which
  // is a hook-driven convenience and returns null here — it expects hooks this
  // client has not registered. The two calls below are what it wraps.
  const payload = await agent.inner.createPaymentPayload(required);
  const payHeaders = agent.pay.encodePaymentSignatureHeader(payload);
  if (!payHeaders) throw new Error('could not encode the payment signature');

  const second = await fetch(url, {
    ...init,
    headers: { ...init.headers, ...payHeaders },
  });
  const text = await second.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return {
    status: second.status,
    body: json,
    settlement: second.headers.get('payment-response'),
    paid: true,
  };
}

function pick(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const mate = moves.find((m) => m.san.includes('#'));
  if (mate) return mate;
  const v = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  return (
    moves.filter((m) => m.captured).sort((a, b) => (v[b.captured] ?? 0) - (v[a.captured] ?? 0))[0] ??
    moves[0]
  );
}

const usdc = async (agent, addr) =>
  agent.wallet.readContract({
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
            inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [addr],
  });

const POT = '0x7D9B82AD6967cA8c8fDA6586718f76391C612d99';
const fmt = (n) => (Number(n) / 1e6).toFixed(6);

async function main() {
  const alpha = makeAgent(wallets.find((w) => w.name === 'alpha'));
  const beta = makeAgent(wallets.find((w) => w.name === 'beta'));

  console.log('\nBalances before');
  console.log(`  alpha ${alpha.address}  ${fmt(await usdc(alpha, alpha.address))} USDC`);
  console.log(`  beta  ${beta.address}  ${fmt(await usdc(beta, beta.address))} USDC`);
  console.log(`  pot   ${POT}  ${fmt(await usdc(alpha, POT))} USDC`);

  console.log('\n1. Paying entry fees over x402 (real USDC on Base)');
  const joinA = await payAndCall(alpha, '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
  console.log(`  alpha → ${joinA.status} ${JSON.stringify(joinA.body).slice(0, 160)}`);
  if (joinA.settlement) console.log(`  settlement: ${joinA.settlement.slice(0, 80)}…`);
  // 409 "Already searching" means alpha is ALREADY in the queue from an earlier
  // run — and, crucially, it was refused BEFORE being charged again, so no fee
  // was burned. Carry on rather than treating a paid-for seat as a failure.
  const alphaSeated = joinA.status === 200 || /already searching/i.test(JSON.stringify(joinA.body));
  if (!alphaSeated) { console.log('\nalpha could not join — stopping.'); process.exit(1); }
  if (joinA.status === 409) console.log('  (alpha was already queued from an earlier run — not re-charged)');

  if (process.argv.includes('--probe')) {
    console.log(`\n  pot now ${fmt(await usdc(alpha, POT))} USDC`);
    console.log('  probe only — stopping before the second entry.');
    return;
  }

  const joinB = await payAndCall(beta, '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
  console.log(`  beta  → ${joinB.status} ${JSON.stringify(joinB.body).slice(0, 160)}`);

  const matchId = joinB.body.matchId ?? joinA.body.matchId;
  if (!matchId) { console.log('\nNo match id — stopping.'); process.exit(1); }
  console.log(`\n  → match ${matchId}`);
  console.log(`  pot now ${fmt(await usdc(alpha, POT))} USDC`);

  console.log('\n2. Playing');
  const view = await call(alpha, 'GET', `/v1/chess/${matchId}`);
  const alphaIsWhite = view.body.colour === 'white';
  const seats = { white: alphaIsWhite ? alpha : beta, black: alphaIsWhite ? beta : alpha };

  const chess = new Chess();
  let terminal = null, reason = null, plies = 0;
  while (plies < 300 && !chess.isGameOver()) {
    const mover = chess.turn() === 'w' ? seats.white : seats.black;
    const mv = pick(chess);
    if (!mv) break;
    const r = await call(mover, 'POST', `/v1/chess/${matchId}/move`, {
      action: 'move', from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}),
    });
    if (r.status !== 200) { console.log(`  move ${plies + 1} rejected: ${JSON.stringify(r.body)}`); break; }
    chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    plies++;
    if (r.body.terminal) { terminal = r.body.terminal; reason = r.body.reason; break; }
    if (plies % 20 === 0) console.log(`  … ${plies} plies`);
  }
  console.log(`  → ${plies} plies, result ${terminal} (${reason})`);

  const winner = terminal === 'p1' ? (alphaIsWhite ? alpha : beta) : (alphaIsWhite ? beta : alpha);
  console.log(`  winner: ${winner.name}`);

  console.log('\n3. Claiming');
  const claims = await call(winner, 'GET', '/v1/claims');
  console.log(`  owed: ${claims.body.unpaidTotal} USDC across ${claims.body.claims?.length ?? 0} claim(s)`);
  const claimId = claims.body.claims?.[0]?.claimId;
  if (!claimId) { console.log('  no claim — stopping.'); return; }

  const paid = await call(winner, 'POST', `/v1/claims/${claimId}/claim`);
  console.log(`  → ${paid.status} ${JSON.stringify(paid.body).slice(0, 240)}`);
  if (paid.body.payoutTx) {
    console.log(`\n  🔗 https://basescan.org/tx/${paid.body.payoutTx}`);
  }

  console.log('\nBalances after');
  console.log(`  alpha ${fmt(await usdc(alpha, alpha.address))} USDC`);
  console.log(`  beta  ${fmt(await usdc(beta, beta.address))} USDC`);
  console.log(`  pot   ${fmt(await usdc(alpha, POT))} USDC`);
}

main().catch((e) => { console.error('\nFAILED:', e?.message ?? e); process.exit(1); });
