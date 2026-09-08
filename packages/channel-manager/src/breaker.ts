/**
 * The claim circuit breaker.
 *
 * Claiming is the only step in batch-settlement that moves money, so it is the
 * step worth bounding. If a bug or an attack inflates what we believe agents
 * owe, this caps how much can actually leave in one interval — the loss becomes
 * a number chosen in advance rather than whatever the accounting happens to say.
 *
 * Kept as a pure function, separate from the manager wiring, because a control
 * nobody can test in isolation is a control nobody trusts.
 */

/** The subset of a channel this decision depends on. */
export interface ClaimCandidate {
  channelId: string;
  /** Cumulative amount the agent has signed vouchers for, base units. */
  signedMaxClaimable: string;
  /** Cumulative amount already claimed on-chain, base units. */
  totalClaimed: string;
}

export interface BreakerState {
  /** Value claimed so far in the current interval, base units. */
  claimedThisInterval: bigint;
  /** Epoch ms the current interval began. */
  intervalStartedAt: number;
}

export interface BreakerDecision<T> {
  /** Channels cleared to claim now. */
  selected: T[];
  /** Channels deferred to a later interval because the ceiling was reached. */
  deferred: T[];
  /** State to carry into the next call. */
  state: BreakerState;
  /** True when the ceiling bound this decision — worth alerting on. */
  ceilingHit: boolean;
}

/** Amount a channel is owed. Never negative, even if bookkeeping disagrees. */
export function owedBy(c: ClaimCandidate): bigint {
  const owed = BigInt(c.signedMaxClaimable) - BigInt(c.totalClaimed);
  return owed > 0n ? owed : 0n;
}

/**
 * Choose which channels may be claimed now.
 *
 * Deferral, not rejection: a channel held back this interval is claimed in a
 * later one, and the agent's signed vouchers remain valid. Nothing is forfeited.
 *
 * Channels are considered in descending order of amount owed, so that when the
 * ceiling binds we settle the largest real debts first rather than whichever
 * happened to sort first — otherwise a flood of dust channels could starve a
 * genuine one indefinitely.
 */
export function selectWithinCeiling<T extends ClaimCandidate>(
  channels: readonly T[],
  ceiling: bigint | undefined,
  state: BreakerState,
  now: number,
  intervalMs = 3_600_000,
): BreakerDecision<T> {
  let { claimedThisInterval, intervalStartedAt } = state;

  if (now - intervalStartedAt >= intervalMs) {
    claimedThisInterval = 0n;
    intervalStartedAt = now;
  }

  const claimable = channels.filter((c) => owedBy(c) > 0n);

  if (ceiling === undefined) {
    return {
      selected: [...claimable],
      deferred: [],
      state: { claimedThisInterval, intervalStartedAt },
      ceilingHit: false,
    };
  }

  // Never returns 0 for equal amounts if written as a bare ternary, which makes
  // the comparator inconsistent — compare(a,b) and compare(b,a) both say "a
  // first" — and leaves the order among equal debts up to the sort's internals.
  const ordered = [...claimable].sort((a, b) => {
    const [x, y] = [owedBy(a), owedBy(b)];
    return x === y ? 0 : y > x ? 1 : -1;
  });

  const selected: T[] = [];
  const deferred: T[] = [];
  let running = claimedThisInterval;
  let ceilingHit = false;

  for (const c of ordered) {
    const owed = owedBy(c);
    if (running + owed > ceiling) {
      // Keep scanning rather than breaking: a smaller channel further down may
      // still fit under the ceiling, and deferring it too would be needless.
      deferred.push(c);
      ceilingHit = true;
      continue;
    }
    running += owed;
    selected.push(c);
  }

  return {
    selected,
    deferred,
    state: { claimedThisInterval: running, intervalStartedAt },
    ceilingHit,
  };
}
