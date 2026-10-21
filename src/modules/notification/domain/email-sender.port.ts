/**
 * One plain-text email (story 6.2, FR19). There is never an HTML part.
 * `headers` carries extra headers such as `List-Unsubscribe` (stories 6.3 and
 * 6.7).
 */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
};

/**
 * What became of a send (ARCHITECTURE 5.6).
 *
 * - `accepted`: the SMTP server took the message.
 * - `transient`: worth retrying. A network error, a timeout, a 4xx, an error
 *   with no SMTP code, or a 5xx at login or `MAIL FROM`, which says
 *   WatchDog's own settings are wrong and would recur for every email.
 * - `permanent`: a 5xx to `RCPT TO` or `DATA`, which concerns this recipient
 *   or this message.
 *
 * `diagnostic` becomes a delivery's `last_error` (story 6.7). It is
 * `SMTP <code>` or an error code such as `ETIMEDOUT`, and never holds the
 * recipient's address.
 */
export type SendResult =
  | { outcome: 'accepted' }
  | { outcome: 'transient' | 'permanent'; diagnostic: string };

export interface EmailSender {
  /** Never throws. */
  send(message: EmailMessage): Promise<SendResult>;
}
