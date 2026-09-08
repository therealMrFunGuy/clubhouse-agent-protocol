/** Worker bindings and configuration. */
export interface Env {
  /** CAIP-2 network to price in. Defaults to eip155:8453 (Base mainnet). */
  X402_NETWORK?: string;
  /** Override the facilitator. Swappable by design — see x402.ts. */
  X402_FACILITATOR_URL?: string;
  /**
   * "1" turns the paywall off in favour of wallet-signature entry.
   *
   * Testnets only, enforced in paper.ts by refusing every request rather than
   * by falling back to charging. Never set this on a production gateway.
   */
  X402_PAPER_MODE?: string;
  /** Destination for agent entry fees. Separate from the human treasury. */
  AGENT_POT_ADDRESS: string;

  /** Decimal USDC strings, e.g. "1.00". */
  PRICE_RANKED_SEAT?: string;
  PRICE_TOURNAMENT_ENTRY?: string;

  /** Private origin base, e.g. https://goclubhouse.io */
  ORIGIN_BASE_URL: string;
  /** Shared secret for the HMAC the origin requires. Never logged. */
  ORIGIN_HMAC_SECRET: string;

  /**
   * Per-IP counters for ANONYMOUS reads — see quota.ts.
   *
   * Optional, and fails open when absent: this is a runaway backstop, not an
   * authorisation decision. Agents that carry a wallet are metered at the
   * origin, where the wallet is proven; this covers the public reads that by
   * design have no wallet to meter.
   */
  QUOTA?: DurableObjectNamespace;

  /** Requests per minute per client IP for anonymous reads. Default 300. */
  AGENT_EDGE_QUOTA_PER_MIN?: string;
}

/**
 * ## Two bindings that used to be declared here, and why they are gone
 *
 * `AUDIT` (R2) and `STATE` (KV) were listed as REQUIRED for months, bound to
 * nothing in wrangler.jsonc ("bindings to add in Phase 1"), and read by no code.
 * A required field for something that does not exist is a type that lies: it
 * says the Worker has an audit sink and a replay store, and it has neither.
 *
 * Neither is missing as a CONTROL, which is why they are deleted rather than
 * built:
 *
 *   - The audit log is hash-chained per wallet in the origin's database and
 *     served at `/v1/audit/{wallet}`. A second copy written at the edge would be
 *     a second source of truth that can disagree with the first, and a
 *     tamper-evident log with two versions is worse than one with a single
 *     version.
 *   - Replay is guarded by a Redis-backed one-shot nonce at the origin, which
 *     refuses outright when that store is unavailable rather than degrading.
 *     The edge has nothing to add: it would be a second window an attacker gets
 *     to try, not a tighter one.
 */

/** Resolved caller identity. A wallet is only ever set by a verified payment. */
export interface AgentIdentity {
  /** x402 payer address — proven by signature, never client-asserted. */
  wallet: string | null;
  /** API key id when the caller presented one. */
  keyId: number | null;
  tier: 'anon' | 'free' | 'ranked' | 'partner';
}
