/** Worker bindings and configuration. */
export interface Env {
  /** CAIP-2 network to price in. Defaults to eip155:8453 (Base mainnet). */
  X402_NETWORK?: string;
  /** Override the facilitator. Swappable by design — see x402.ts. */
  X402_FACILITATOR_URL?: string;
  /** Destination for agent entry fees. Separate from the human treasury. */
  AGENT_POT_ADDRESS: string;

  /** Decimal USDC strings, e.g. "1.00". */
  PRICE_RANKED_SEAT?: string;
  PRICE_TOURNAMENT_ENTRY?: string;

  /** Private origin base, e.g. https://goclubhouse.io */
  ORIGIN_BASE_URL: string;
  /** Shared secret for the HMAC the origin requires. Never logged. */
  ORIGIN_HMAC_SECRET: string;

  /** Per-key and per-wallet quota counters. */
  QUOTA: DurableObjectNamespace;
  /** Append-only audit log sink. */
  AUDIT: R2Bucket;
  /** Replay-nonce and short-lived state. */
  STATE: KVNamespace;
}

/** Resolved caller identity. A wallet is only ever set by a verified payment. */
export interface AgentIdentity {
  /** x402 payer address — proven by signature, never client-asserted. */
  wallet: string | null;
  /** API key id when the caller presented one. */
  keyId: number | null;
  tier: 'anon' | 'free' | 'ranked' | 'partner';
}
