/**
 * Whether an `Origin` header names an origin the admin surface trusts
 * (story 4.7, ARCHITECTURE 5.5).
 *
 * A browser attaches the session cookie to a cross-site WebSocket upgrade, and
 * the upgrade is not subject to CORS, so the `Origin` it sends is the only
 * thing that tells a page on another site from the dashboard. The header must
 * be exactly one of the trusted origins, as a browser serializes it: a missing
 * header, the opaque `null`, and anything that is not an origin are refused.
 *
 * Pure, and handed the list rather than reading configuration, so the unit
 * suite can run it without a `.env`.
 */
export function isTrustedOrigin(
  origin: string | undefined,
  trusted: readonly string[],
): boolean {
  if (!origin) return false;
  return trusted.some((entry) => {
    const serialized = URL.parse(entry)?.origin;
    // An opaque origin serializes as "null", which must never match a header.
    return (
      serialized !== undefined && serialized !== 'null' && serialized === origin
    );
  });
}
