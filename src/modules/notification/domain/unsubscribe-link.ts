import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed unsubscribe link (story 6.4, ARCHITECTURE 5.6). Nothing is stored:
 * the signature is base64url (no padding) of HMAC-SHA256 over
 * `unsubscribe\n<orgId>\n<subscriberId>`, keyed by `NOTIFICATION_LINK_SECRET`.
 * The leading label keeps a later link signed with the same secret from
 * unsubscribing. The secret is an argument, so this file imports no config.
 */
export function signUnsubscribe(
  secret: string,
  orgId: string,
  subscriberId: string,
): string {
  return createHmac('sha256', secret)
    .update(`unsubscribe\n${orgId}\n${subscriberId}`)
    .digest('base64url');
}

/**
 * Never throws. The recomputed string is compared with the supplied one, not
 * decoded bytes, so the alternative spellings 43 characters allow are refused.
 */
export function verifyUnsubscribe(
  secret: string,
  orgId: string,
  subscriberId: string,
  signature: string,
): boolean {
  try {
    const expected = Buffer.from(signUnsubscribe(secret, orgId, subscriberId));
    const supplied = Buffer.from(signature, 'utf8');
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}

/** The link an email carries (story 6.7). */
export function unsubscribeLink(
  publicBaseUrl: string,
  orgSlug: string,
  orgId: string,
  subscriberId: string,
  secret: string,
): string {
  const signature = signUnsubscribe(secret, orgId, subscriberId);
  return `${publicBaseUrl}/status/${orgSlug}/subscribers/unsubscribe?subscriber=${subscriberId}&signature=${signature}`;
}
