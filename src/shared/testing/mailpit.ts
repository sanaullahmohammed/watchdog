import { randomBytes } from 'node:crypto';
import { env } from '@/config';

/**
 * Reads what reached Mailpit, over its HTTP API v1 (story 6.2). Integration
 * files run concurrently against one Mailpit, so a test sends to its own
 * `uniqueRecipient()` and reads only that address's messages.
 *
 * Mailpit's API is on 8025 of the host the SMTP settings point at.
 */
const baseUrl = () => `http://${env.email.host}:8025/api/v1`;

export type MailpitAddress = { Name: string; Address: string };

export type MailpitMessage = {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  /** Mailpit keeps the trailing newline; compare it trimmed. */
  Text: string;
  HTML: string;
  /** Header name as sent, to every value it carries. */
  Headers: Record<string, string[]>;
};

/** An address no other test, or run, sends to. */
export function uniqueRecipient(label = 'mail'): string {
  return `${label}-${randomBytes(8).toString('hex')}@watchdog.test`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

async function readOnce(address: string): Promise<MailpitMessage[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const found = await getJson<{ messages: { ID: string }[] | null }>(
    `${baseUrl()}/search?query=${query}`,
  );
  return Promise.all(
    (found.messages ?? []).map(async ({ ID }) => {
      const [message, Headers] = await Promise.all([
        getJson<Omit<MailpitMessage, 'Headers'>>(`${baseUrl()}/message/${ID}`),
        getJson<Record<string, string[]>>(`${baseUrl()}/message/${ID}/headers`),
      ]);
      return {
        ID: message.ID,
        From: message.From,
        To: message.To,
        Subject: message.Subject,
        Text: message.Text,
        HTML: message.HTML,
        Headers,
      };
    }),
  );
}

/**
 * Every message Mailpit holds for `address`. Mailpit stores a message before
 * it answers 250, so reading right after `send` resolves sees it. With
 * `atLeast`, it waits up to `timeoutMs` for that many to arrive.
 */
export async function messagesTo(
  address: string,
  {
    atLeast = 0,
    timeoutMs = 2_000,
  }: { atLeast?: number; timeoutMs?: number } = {},
): Promise<MailpitMessage[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await readOnce(address);
    if (messages.length >= atLeast || Date.now() >= deadline) return messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
