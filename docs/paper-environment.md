# The paper environment

A complete, isolated copy of the agent path with no real money in it: local
MySQL and Redis, a local origin, the gateway in paper mode, and agents holding
throwaway keys. It exists so the seams can be exercised end to end — signing,
pairing, the trust boundary, the shared move core, settlement and the audit
chain — before anyone's USDC is involved.

## Why paper mode is shaped the way it is

Paper mode replaces the x402 paywall with a wallet signature. That is, plainly,
a switch that turns payment off, so the whole design of `gateway/src/paper.ts`
is about making it impossible to leave on:

- it engages only when `X402_PAPER_MODE` is exactly `"1"`;
- if that flag is set while `X402_NETWORK` is **not** a testnet, the gateway
  refuses **every** request with a 500 — it does not quietly fall back to
  charging properly. A gateway misconfigured this way is visibly broken rather
  than subtly free;
- every paper response is stamped `paper: true` in the body and
  `x-cap-paper-mode: 1` in the headers, so a paper result cannot be mistaken for
  a real one in a log or a screenshot.

The tempting alternative — "if paper mode is on but the network is mainnet, just
charge normally" — fails safe today and fails open the moment a later edit
inverts the condition. Refusing outright cannot degrade.

## Standing it up

The database must be genuinely isolated. On a workstation that tunnels to
production, `localhost:3306` may well be prod RDS — check before you point
anything at it.

```bash
docker run -d --name cap-paper-mysql \
  -e MYSQL_ROOT_PASSWORD=paper -e MYSQL_DATABASE=rjctd_shared \
  -p 127.0.0.1:3399:3306 mysql:8.4
docker run -d --name cap-paper-redis -p 127.0.0.1:6399:6379 redis:7-alpine
```

`--default-authentication-plugin` was **removed** in MySQL 8.4; passing it makes
the container exit on boot.

Load the schema into the two databases the agent path uses — `rjctd_shared` for
identity, payments and the audit log, and the per-chain database for matches and
ratings:

```bash
mysql ... -e "CREATE DATABASE IF NOT EXISTS rjctd_clubhouse_base"
cat db/migrations/143_game_systems.sql \
    db/migrations/145_game_queue_single_search.sql | mysql ... rjctd_clubhouse_base
cat db/migrations/194_agent_protocol.sql          | mysql ... rjctd_shared
```

Origin (private repo), with the paper database and a 32+ byte secret:

```bash
AWS_RDS_HOST=127.0.0.1 AWS_RDS_PORT=3399 AWS_RDS_USER=root AWS_RDS_PASSWORD=paper \
REDIS_ENABLED=true REDIS_URL=redis://127.0.0.1:6399 \
AGENT_GATEWAY_HMAC_SECRET=<64 hex chars> \
npx next dev -p 3011
```

Redis is **required**, not optional. The envelope refuses to verify without a
shared replay store, because the in-process fallback would permit one replay per
PM2 worker against a money path.

Gateway:

```bash
# gateway/.dev.vars.paper  (gitignored via .dev.vars*)
ORIGIN_HMAC_SECRET=<the same 64 hex chars>
AGENT_POT_ADDRESS=0x...

npx wrangler dev --env paper --port 8799 --local
```

`--env paper` reads `.dev.vars.paper`, **not** `.dev.vars`. Getting this wrong
produces a valid-looking gateway whose every request fails `bad_signature` at
the origin, because the two sides are signing with different secrets.

## Running it

```bash
node scripts/smoke-paper.mjs    # two agents play a full game to a result
node scripts/probe-replay.mjs   # replay, tampering, clock and double-spend probes
```

The smoke test drives everything over HTTP through the gateway exactly as a
third-party agent would: it never imports app code, so it cannot pass by
agreeing with itself. It checks the trust boundary first (unsigned refused, one
wallet's signature cannot claim another), plays a real game to checkmate, then
confirms settlement, Elo, and that both agents are labelled `agent` on the
ladder.

`probe-replay.mjs` is the adversarial half: an identical envelope replayed, a
body swapped after signing, a signature reused on a different path, stale and
far-future clocks, one payment nonce used for two seats, and an agent trying to
be matched against itself.

## Verifying afterwards

Two things are worth checking directly in the database, because both are
failures that a green test run would not show:

```sql
-- The match must be in the chain database its payment settled on, NOT the
-- platform's default chain. gamesDb() falls back to Solana silently whenever
-- the context chain is not fully configured.
SELECT id, status, result FROM rjctd_clubhouse_base.game_matches;

-- One settled payment, one seat. The unique index on nonce is the guard.
SELECT nonce, chain_id, state FROM rjctd_shared.agent_x402_payments;
```

The audit chain can be re-derived independently — that is the point of
publishing it. Walk each wallet's entries in `seq` order, confirm the first
`prev_hash` is the genesis (64 zeroes), that each subsequent `prev_hash` equals
the previous `row_hash`, and that

```
row_hash = sha256(wallet \n seq \n method \n endpoint \n body_hash \n decision \n prev_hash)
```

## What this does NOT prove

The paper environment deliberately stops short of money. It does not exercise a
real x402 settlement, a facilitator, the batch-settlement channel manager, or
any on-chain transfer. Those need a funded Base Sepolia wallet and are the next
step, not this one.
