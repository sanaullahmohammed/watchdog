import type { FastifyReply } from 'fastify';
import { publicHeaders } from '@/shared/api/public-surface';

/**
 * The plain-text answers of the emailed links (story 6.4). A link that acts on
 * GET answers a person in a browser, so it answers text, and every miss is one
 * byte-identical answer.
 */
export const INVALID_LINK_TEXT =
  'This link is not valid. It may have expired or already been used.';

export const confirmedText = (orgName: string) =>
  `Your subscription to ${orgName} status updates is confirmed.`;

export const unsubscribedText = (orgName: string) =>
  `You are unsubscribed from ${orgName} status updates.`;

/** `onSend` for these routes: the public headers on every answer, 429 included. */
export const linkOnSend = async (
  _req: unknown,
  res: Parameters<typeof publicHeaders>[0],
  payload: unknown,
) => {
  publicHeaders(res);
  res.header('cache-control', 'no-store');
  return payload;
};

/** A link's answer: text, never cached. */
export function sendLinkText(res: FastifyReply, status: number, text: string) {
  return res
    .code(status)
    .header('cache-control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(text);
}
