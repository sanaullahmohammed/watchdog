import { createHash, randomBytes } from 'node:crypto';

/**
 * A confirmation token (story 6.3): 32 random bytes, base64url in the link.
 * Only the SHA-256 hex of it is stored, because a high-entropy token needs no
 * slow hash.
 */
export function generateConfirmationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashConfirmationToken(token) };
}

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
