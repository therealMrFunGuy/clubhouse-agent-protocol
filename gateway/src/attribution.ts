/**
 * Who paid, and under which authorization.
 *
 * ## Why this is its own file
 *
 * It was three lines inside the Worker's paid branch, and it was wrong for two
 * of the three assets we sell:
 *
 *     const auth = payload.payload?.authorization ?? {};
 *     const payer = auth.from ?? null;
 *
 * `authorization` is the EIP-3009 shape. A permit2 payment carries
 * `permit2Authorization` instead, with the payer and the nonce in exactly the
 * same roles:
 *
 *     eip3009:  { authorization:        { from, to, value, validAfter,
 *                                         validBefore, nonce }, signature }
 *     permit2:  { permit2Authorization: { from, permitted, spender, nonce,
 *                                         deadline, witness }, signature }
 *
 * So every WETH and CRED payment arrived with `payer === null` and was refused
 * `502 Payment could not be attributed` — after the client had signed it and
 * the facilitator had verified it. Both assets were advertised, priced,
 * documented and provably payable, and neither could ever have been paid with.
 *
 * ## The pattern, stated once
 *
 * This is the FOURTH defect of one shape on this surface: code reading a field
 * that exists on one payload variant and not another. `payerOf` in the origin
 * read four fields that exist on neither. A metered 402 omitted the fields the
 * payer needs while satisfying the verifier, twice.
 *
 * They share a cause. A payload has variants; the code was written against the
 * one in front of whoever wrote it; nothing exercised the others. So the rule
 * is: **read the shape you were given, not the one you wrote the code
 * against** — and prove it against a real payload of each shape, which is what
 * the tests beside this file do.
 *
 * It lives here rather than in the Worker so it can be called directly by a
 * test, because the alternative — asserting on the Worker's source text — is
 * exactly what let the original survive review.
 */

/** The two authorization shapes an `exact` payment can carry. */
export type AuthorizationFlow = 'eip3009' | 'permit2';

export interface Attribution {
  payer: string | null;
  /** The settlement nonce, which is the payment's identity downstream. */
  nonce: string | null;
  /** Which shape it came from — null when neither was recognised. */
  flow: AuthorizationFlow | null;
}

/**
 * Pull the payer and nonce out of a verified payment payload.
 *
 * Returns nulls rather than throwing: the caller refuses the payment and says
 * so, and a throw here would turn a payment we merely cannot read into a
 * 500 from the Worker.
 */
export function attributePayment(payload: unknown): Attribution {
  const inner = (payload as any)?.payload;
  if (!inner || typeof inner !== 'object') {
    return { payer: null, nonce: null, flow: null };
  }

  // EIP-3009 first, because it is the only shape that can also be a DEPOSIT
  // authorization on the batch-settlement path — checking permit2 first would
  // read the wrong sibling on a payload that carries both.
  const eip3009 = inner.authorization;
  if (eip3009 && typeof eip3009 === 'object') {
    return {
      payer: typeof eip3009.from === 'string' ? eip3009.from : null,
      nonce: typeof eip3009.nonce === 'string' ? eip3009.nonce : null,
      flow: 'eip3009',
    };
  }

  const permit2 = inner.permit2Authorization;
  if (permit2 && typeof permit2 === 'object') {
    return {
      payer: typeof permit2.from === 'string' ? permit2.from : null,
      nonce: typeof permit2.nonce === 'string' ? permit2.nonce : null,
      flow: 'permit2',
    };
  }

  return { payer: null, nonce: null, flow: null };
}
