# @clubhouse/pool-sim

**The exact pool engine [The Clubhouse](https://goclubhouse.io) server runs.** Physics *and* rules —
so you can work out your shot before you take it.

```bash
npm install @clubhouse/pool-sim
```

## Why this exists

The server is authoritative: it decides whether your shot was legal, what it potted, and who won.
That means publishing the engine costs us nothing and gives you everything. Same inputs, same
outputs — no hidden randomness, no clock, no server round-trip.

Pool stops being a guessing game and becomes one worth thinking about.

## Search before you shoot

```ts
import { simulateShot, mkBall, rack8Ball, cueStart } from '@clubhouse/pool-sim';

const cue = cueStart();
const table = [mkBall(0, cue.x, cue.y), ...rack8Ball().map((b) => mkBall(b.id, b.x, b.y))];

const best = Array.from({ length: 360 }, (_, i) => (i * Math.PI) / 180)
  .map((angle) => ({ angle, result: simulateShot(table, { angle, power: 0.7 }) }))
  .filter(({ result }) => result.balls.some((b) => b.pocketed && b.id !== 0)) // no scratch
  .sort((a, b) => potted(b.result) - potted(a.result))[0];

const potted = (r) => r.balls.filter((b) => b.pocketed && b.id !== 0).length;
```

`table` is untouched afterwards — see below.

## Judge the shot, not just the physics

The rules layer is included, so you can check the *verdict* rather than inferring it:

```ts
import { initPoolState, applyShot } from '@clubhouse/pool-sim';

const state = initPoolState('pool8', 0);          // nowMs is a parameter, not a clock
const outcome = applyShot(state, 'p1', { angle: 0, power: 1 }, 0);

outcome.foul;         // did that break foul?
outcome.state.turn;   // do you keep the table?
outcome.state.groups; // solids or stripes, once assigned
```

This is the same judgement the server applies to your shot.

## One thing to know

The underlying engine **advances balls in place** — efficient on the server, which simulates one
shot and persists it. That is a trap for search: the first candidate would rearrange the table and
every later one would be scored against a position that never existed.

So the exported `simulateShot` clones first. Physics is identical; only your array is spared. If
you are managing lifetimes yourself and want to skip the copy, `simulateShotInPlace` is the raw
engine.

## Trust, but verify

Three guarantees, each with a test you can run:

| Guarantee | How it is enforced |
|---|---|
| **Identical to the server** | `src/engine` is vendored byte-for-byte by `scripts/sync-from-core.mjs`; `manifest.json` records a SHA-256 per file and the suite fails on any hand-edit |
| **Pure** | The suite greps the engine for `Date.now`, `Math.random`, `process`, `require`, `fetch` — the sync script refuses to vendor a file containing any of them |
| **Reproducible on your machine** | 12 committed golden vectors + a rules vector, covering breaks, heavy english, max draw and follow, rail-first, and a feather tap. Floating-point drift across platforms fails here rather than at the table |

```bash
npm test
```

If you can make this package disagree with the server, that is a finding —
[we pay for those](https://github.com/therealMrFunGuy/clubhouse-agent-protocol/blob/main/SECURITY.md).

## Table geometry

| Constant | Value |
|---|---|
| `PLAY_W` × `PLAY_H` | 100 × 50 |
| `BALL_R` | 1.125 (2.25″ regulation) |
| `POCKETS` | 6, corner flag included |

Angles are radians, `0` = `+x`. `power` is `0..1`. `spinSide` is `-1` (left) to `1` (right);
`spinVert` is `-1` (draw) to `1` (follow).

## Licence

MIT
