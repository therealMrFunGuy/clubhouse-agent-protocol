/**
 * The URL we advertise must be the URL that works.
 *
 * ## The defect
 *
 * The tournament route advertised
 * `https://agents.goclubhouse.io/v1/tournaments/join`. That is not a route.
 * Every method against it answers 404 — the real path carries the id
 * (`/v1/tournaments/1/join`). So the one URL we published for that resource was
 * the one URL nobody could pay, and anything that probes an advertised resource
 * before trusting it saw a dead endpoint.
 *
 * The sibling defect: a GET against a priced path fell through to the terminal
 * `Not found`. 404 and 405 say opposite things — "nothing lives here" versus
 * "something lives here, you asked wrong" — and we were sending the stronger
 * denial to the most likely probe of an advertised URL.
 *
 * ## Why these assertions and not others
 *
 * Both shapes were found by diffing our live 402 against resources that ARE
 * indexed in the Bazaar, not from documentation:
 *
 *   - of 100 sampled indexed resources, 9 carry a path parameter, and 9 of
 *     those 9 spell it `:name` in `resource` and repeat it in
 *     `extensions.bazaar.routeTemplate` (reference: api.onesource.io).
 *   - stableenrich.dev is a POST-only route, indexed, and answers a GET with
 *     405. We answered 404.
 *
 * That discipline matters here: the same comparison refuted a more obvious
 * theory first. Our 402 returns an empty `{}` body with the requirements in the
 * `payment-required` header, which looked like the obvious culprit — until
 * probing indexed peers showed 5 of 12 do exactly the same and are indexed
 * anyway. Neither fix below is claimed as the cause of our non-indexing. They
 * are things that were wrong on their own terms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoutes } from '../src/x402.ts';
import { isPaidRoute, allowedMethodsFor } from '../src/pricedRoutes.ts';

const routes = buildRoutes({
  AGENT_POT_ADDRESS: '0x000000000000000000000000000000000000dEaD',
});

/** `/v1/tournaments/:tournamentId/join` → `/v1/tournaments/sample/join`. */
const fillPlaceholders = (path) => path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, 'sample');

test('every advertised resource URL routes to the route it prices', () => {
  // The assertion the old tournament URL failed. Substituting a value for each
  // `:param` must produce a path the gateway actually prices — otherwise we are
  // publishing a URL that 404s.
  for (const [name, route] of Object.entries(routes)) {
    const path = new URL(route.resource).pathname;
    const concrete = fillPlaceholders(path);
    assert.ok(
      isPaidRoute(concrete),
      `${name} advertises ${route.resource}, which resolves to ${concrete} — not a priced route`,
    );
  }
});

test('a resource URL with a path parameter also declares routeTemplate', () => {
  // Both halves, the way every path-parameterised resource in the indexed
  // catalogue declares them. A placeholder in the URL with no template is half
  // a declaration.
  for (const [name, route] of Object.entries(routes)) {
    const path = new URL(route.resource).pathname;
    if (!path.includes(':')) continue;
    const template = route.extensions?.bazaar?.routeTemplate;
    assert.equal(template, path, `${name} declares routeTemplate ${template}, expected ${path}`);
  }
});

test('the tournament resource names its id in the path, not the body', () => {
  // Pinning the specific regression: the id belongs in the URL.
  const tournament = routes['POST /v1/tournaments/*/join'];
  assert.match(tournament.resource, /\/v1\/tournaments\/:tournamentId\/join$/);
  // And the declared pathParams key must be the same name the URL uses, or an
  // agent filling the template still cannot build the call.
  assert.ok(
    'tournamentId' in tournament.extensions.bazaar.info.input.pathParams,
    'pathParams does not name tournamentId',
  );
});

test('a priced path reached by the wrong method is 405, not 404', () => {
  // The A/B against stableenrich.dev, which is indexed and answers 405.
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
    assert.deepEqual(allowedMethodsFor(method, '/v1/matchmaking/queue'), ['POST']);
    assert.deepEqual(allowedMethodsFor(method, '/v1/tournaments/1/join'), ['POST']);
  }
});

test('POST and OPTIONS never 405', () => {
  // POST is the method that works, so it must fall through to the paid path.
  assert.equal(allowedMethodsFor('POST', '/v1/matchmaking/queue'), null);
  // OPTIONS is the CORS preflight. A 405 to a preflight breaks every browser
  // caller — which is why this is asserted rather than left to the reader.
  assert.equal(allowedMethodsFor('OPTIONS', '/v1/matchmaking/queue'), null);
});

test('an unknown path still 404s — 405 must not swallow genuine misses', () => {
  // The failure mode of a too-eager 405: every typo starts claiming a resource
  // exists. Only paths we actually price may answer 405.
  for (const path of ['/v1/matchmaking', '/v1/nope', '/v1/tournaments/1', '/', '/v1/games']) {
    assert.equal(allowedMethodsFor('GET', path), null, `${path} should not claim to exist`);
  }
});
