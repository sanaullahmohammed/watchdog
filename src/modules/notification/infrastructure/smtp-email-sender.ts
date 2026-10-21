import { createTransport } from 'nodemailer';
import type {
  EmailMessage,
  EmailSender,
  SendResult,
} from '@/modules/notification/domain/email-sender.port';

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
};

/** Milliseconds. */
export type SmtpTimeouts = {
  dns: number;
  connection: number;
  greeting: number;
  socket: number;
  /** The whole send, from first lookup to the server's last reply. */
  overall: number;
};

/**
 * nodemailer's own defaults (2 min to connect, 10 min of inactivity) could
 * stall a worker pass, and it has no overall limit at all. The overall limit
 * must stay below story 6.7's claim lease, the `next_attempt_at` bump a pass
 * makes when it claims a row, which 6.7 sets from
 * `NOTIFICATION_RETRY_BASE_SECONDS` (60 s by default). The lease must cover
 * each claimed row's own send, and its wait behind the rows sent before it
 * (deferred-work, story 6.2).
 */
export const SMTP_TIMEOUTS: Readonly<SmtpTimeouts> = Object.freeze({
  dns: 10_000,
  connection: 10_000,
  greeting: 10_000,
  socket: 15_000,
  overall: 45_000,
});

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Turns a nodemailer failure into a result. Reads only `responseCode`,
 * `command` and `code`: the error's `name`, `message` and `response`, and a
 * refusal's `rejected` and `rejectedErrors`, can all quote the recipient.
 *
 * Permanent only for a 5xx to `RCPT TO` or `DATA`, which concerns this
 * recipient or this message. A 5xx at the greeting, at login or at
 * `MAIL FROM` means WatchDog's own settings are wrong; it would recur for
 * every email, so it is retried (ARCHITECTURE 5.6, owner 2026-10-21).
 */
export function classifySmtpFailure(error: unknown): SendResult {
  try {
    const { responseCode, command, code } = (
      typeof error === 'object' && error !== null ? error : {}
    ) as { responseCode?: unknown; command?: unknown; code?: unknown };
    const reply =
      typeof responseCode === 'number' &&
      Number.isInteger(responseCode) &&
      responseCode >= 100 &&
      responseCode <= 599
        ? responseCode
        : undefined;
    const diagnostic =
      reply !== undefined
        ? `SMTP ${reply}`
        : typeof code === 'string' && ERROR_CODE.test(code)
          ? code
          : 'EUNKNOWN';
    const permanent =
      reply !== undefined &&
      reply >= 500 &&
      (command === 'RCPT TO' || command === 'DATA');
    return { outcome: permanent ? 'permanent' : 'transient', diagnostic };
  } catch {
    // A getter that throws, say. Nothing about it is safe to report.
    return { outcome: 'transient', diagnostic: 'EUNKNOWN' };
  }
}

/**
 * The SMTP adapter (story 6.2). Takes its settings as arguments and imports
 * no config, so a spec can point it at a local stub.
 *
 * `createTransport` does not connect: each send opens its own connection and
 * closes it, so a server that is down cannot stop api or worker booting.
 * nodemailer's logger stays off, and the sender logs nothing itself.
 *
 * nodemailer cannot abort a send, so one that outlives the overall limit is
 * abandoned, not stopped, and may still be delivered later. Its late result
 * is caught. Delivery is at-least-once, so that duplicate is accepted
 * (ARCHITECTURE 5.6).
 *
 * Returns a plain object, so a test can replace `send` on the resolved
 * singleton.
 */
export function createSmtpEmailSender(
  settings: SmtpSettings,
  timeouts: Partial<SmtpTimeouts> = {},
): EmailSender {
  // Per key, so an override of `undefined` keeps the default.
  const limits: SmtpTimeouts = {
    dns: timeouts.dns ?? SMTP_TIMEOUTS.dns,
    connection: timeouts.connection ?? SMTP_TIMEOUTS.connection,
    greeting: timeouts.greeting ?? SMTP_TIMEOUTS.greeting,
    socket: timeouts.socket ?? SMTP_TIMEOUTS.socket,
    overall: timeouts.overall ?? SMTP_TIMEOUTS.overall,
  };
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.auth ? { auth: { ...settings.auth } } : {}),
    // A login is never sent in cleartext: without implicit TLS it waits for
    // STARTTLS, and a server that does not offer it fails the send.
    ...(settings.auth && !settings.secure ? { requireTLS: true } : {}),
    dnsTimeout: limits.dns,
    connectionTimeout: limits.connection,
    greetingTimeout: limits.greeting,
    socketTimeout: limits.socket,
    logger: false,
    debug: false,
  });

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      // Handled on both paths here, so a result that arrives after the
      // deadline is never an unhandled rejection.
      const attempt = Promise.resolve()
        .then(() =>
          transport.sendMail({
            from: settings.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.headers ? { headers: { ...message.headers } } : {}),
          }),
        )
        .then(
          (): SendResult => ({ outcome: 'accepted' }),
          (error: unknown) => classifySmtpFailure(error),
        );

      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<SendResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ outcome: 'transient', diagnostic: 'EDEADLINE' }),
          limits.overall,
        );
      });
      try {
        return await Promise.race([attempt, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
