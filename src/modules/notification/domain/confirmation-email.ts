import type { EmailMessage } from '@/modules/notification/domain/email-sender.port';

export type ConfirmationEmailInput = {
  to: string;
  orgName: string;
  orgSlug: string;
  token: string;
  ttlHours: number;
  publicBaseUrl: string;
};

/**
 * The confirmation email (story 6.3). Plain text, and no `List-Unsubscribe`:
 * the address has not subscribed yet, and ignoring the email ends it. The link
 * is story 6.4's route.
 */
export function buildConfirmationEmail(
  input: ConfirmationEmailInput,
): EmailMessage {
  const link = `${input.publicBaseUrl}/status/${input.orgSlug}/subscribers/confirm?token=${input.token}`;
  const hours = input.ttlHours === 1 ? '1 hour' : `${input.ttlHours} hours`;
  return {
    to: input.to,
    subject: `Confirm your subscription to ${input.orgName} status updates`,
    text: [
      `Confirm this address to receive ${input.orgName} status updates by email.`,
      '',
      link,
      '',
      `The link works for ${hours}.`,
      '',
      'If you did not ask for this, ignore this email; nothing more will be sent.',
      '',
    ].join('\n'),
  };
}
