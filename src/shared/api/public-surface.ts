/**
 * Headers that let a browser on any origin read the public page.
 *
 * CORS is registered globally with `origin: false`, which is right for every
 * authenticated surface: a page anyone may fetch is not one any site may read
 * with a session attached. So the public surface says so for itself, without
 * credentials. Helmet's default `Cross-Origin-Resource-Policy: same-origin`
 * would block a cross-origin read even with CORS, so it is relaxed here only
 * (Epic 3 retrospective, R-15). `ETag` has to be exposed, or a script cannot
 * read the tag it needs for a conditional request, and `Retry-After`, or it
 * cannot read when a 429 says to come back.
 *
 * Every answer under `/status` carries them, except where Fastify keeps its
 * default (a method the catch-all does not declare, a failed async
 * constraint): the page route's own answers (in `onSend`, errors included),
 * the catch-all route's uniform miss, and the malformed-URL answer of
 * `frameworkErrors`.
 */
export function publicHeaders(res: {
  header: (name: string, value: string) => unknown;
}) {
  res.header('access-control-allow-origin', '*');
  res.header('access-control-expose-headers', 'ETag, Retry-After');
  res.header('cross-origin-resource-policy', 'cross-origin');
}
