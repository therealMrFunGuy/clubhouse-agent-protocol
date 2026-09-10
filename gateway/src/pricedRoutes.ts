/**
 * Which paths cost money, and what to say when one is asked for wrongly.
 *
 * ## Why this is its own file
 *
 * It has NO relative imports, deliberately. Tests import it directly under
 * node's TS type-stripping, where an extensionless relative import does not
 * resolve — the same constraint `x402.ts` documents at its facilitator
 * interface, and the reason that file stays free of relative value imports too.
 * Living in `index.ts` these were untestable: importing the entrypoint drags in
 * the whole worker graph and fails to load.
 */

/**
 * Routes that cost money. The real path also asks the x402 server whether a
 * route is priced, but that answer needs a live facilitator — so the set is
 * named here as well, and paper mode gates on it.
 *
 * Without this, the paper branch would mint a synthetic receipt for ANY POST
 * under /v1/, which is a paper environment that does not model the paywall it
 * exists to rehearse.
 */
// Kept deliberately in step with buildRoutes() in x402.ts. An audit caught the
// first version of this list claiming parity it did not have: it matched
// /v1/matchmaking/<anything> while x402 priced only /v1/matchmaking/queue, and
// it required a numeric tournament id while the spec types that id as a string.
// The result was routes that were free in production and paid in paper, and
// vice versa — a paper environment that rehearses the wrong paywall is worse
// than none, because it produces confident green runs.
export const PAID_ROUTES: RegExp[] = [
  /^\/v1\/matchmaking\/queue$/,
  // Priced again: agent buy-ins and agent tournament prizes now share the same
  // pot, so a bought seat is one the house can actually pay out on.
  /^\/v1\/tournaments\/[^/]+\/join$/,
];

export function isPaidRoute(path: string): boolean {
  return PAID_ROUTES.some((p) => p.test(path));
}

/**
 * A priced path reached by the wrong method: 405, never 404.
 *
 * ## Why the difference matters
 *
 * 404 and 405 say opposite things about a URL. 404 says "nothing lives here";
 * 405 says "something lives here, you asked for it wrong". Our priced routes
 * are POST-only, and a GET against one used to fall all the way through to the
 * terminal `Not found` — so the single most likely probe of an advertised
 * resource got told the resource does not exist.
 *
 * That is not a hypothetical reader. Every indexed peer we probed answers a
 * wrong-method probe with 405 (stableenrich.dev, a POST-only route indexed in
 * the Bazaar, is the direct A/B), and the issue thread's one report of a
 * service that went from never-indexed to indexed names exactly this class of
 * fix: "a bare probe must return 402; a 400 fails the crawler's check". A 404
 * is a stronger denial than a 400.
 *
 * Whether the crawler is the reason is not something we can see from here, and
 * this is NOT claimed as the cause of our non-indexing. It is correct HTTP that
 * we were getting wrong, on the one URL we ask strangers to trust.
 *
 * Returns the methods that ARE allowed, for the `Allow` header a 405 must
 * carry, or null when the path is not one of ours to speak for.
 */
export function allowedMethodsFor(method: string, path: string): string[] | null {
  // OPTIONS is answered by the CORS preflight and must never 405 — returning
  // 405 to a preflight breaks every browser caller.
  if (method === 'POST' || method === 'OPTIONS') return null;
  return isPaidRoute(path) ? ['POST'] : null;
}
