import type { EmailMessage } from '@/modules/notification/domain/email-sender.port';

/** What a delivery is about, read from the current rows when it is claimed. */
export type NotificationSource =
  | {
      sourceType: 'incident_update';
      incidentTitle: string;
      /** The status the incident held when the entry was written. */
      status: string;
      message: string;
      postedAt: Date;
    }
  | {
      sourceType:
        | 'maintenance_scheduled'
        | 'maintenance_started'
        | 'maintenance_completed';
      title: string;
      description: string | null;
      scheduledStartAt: Date;
      scheduledEndAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
    };

export type NotificationEmailInput = {
  to: string;
  orgName: string;
  orgSlug: string;
  publicBaseUrl: string;
  unsubscribeUrl: string;
  source: NotificationSource;
};

/** `2026-10-22 14:05 UTC`. */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');

const capitalise = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * How one public change is worded, without the organization tag or any link:
 * the title (the email subject without `[Org] `) and the change lines (the
 * email body above its page and unsubscribe links). The email and the Atom
 * feed (story 6.8) both build from it, so they cannot drift. The title holds
 * no line break.
 */
export function describeChange(source: NotificationSource): {
  title: string;
  lines: string[];
} {
  let title: string;
  let lines: string[];

  switch (source.sourceType) {
    case 'incident_update':
      title = `${source.incidentTitle}: ${capitalise(source.status)}`;
      lines = [
        `Status: ${capitalise(source.status)}`,
        '',
        source.message,
        '',
        `Posted ${formatUtc(source.postedAt)}.`,
      ];
      break;
    case 'maintenance_scheduled':
      title = `Maintenance scheduled: ${source.title}`;
      lines = [
        `Scheduled start: ${formatUtc(source.scheduledStartAt)}`,
        `Scheduled end: ${formatUtc(source.scheduledEndAt)}`,
        ...(source.description ? ['', source.description] : []),
      ];
      break;
    case 'maintenance_started':
      title = `Maintenance started: ${source.title}`;
      lines = [
        `Started ${formatUtc(source.startedAt ?? source.scheduledStartAt)}.`,
        `Scheduled end: ${formatUtc(source.scheduledEndAt)}`,
      ];
      break;
    case 'maintenance_completed':
      if (source.startedAt === null) {
        title = `Maintenance ended without starting: ${source.title}`;
        lines = [
          'This maintenance window ended without starting.',
          '',
          `Scheduled start: ${formatUtc(source.scheduledStartAt)}`,
          `Scheduled end: ${formatUtc(source.scheduledEndAt)}`,
        ];
      } else {
        title = `Maintenance completed: ${source.title}`;
        lines = [
          `Completed ${formatUtc(source.completedAt ?? source.scheduledEndAt)}.`,
        ];
      }
      break;
  }

  return { title: oneLine(title), lines };
}

/**
 * The email for one public change (story 6.7). Plain text, never HTML. Every
 * body ends with the page link and the unsubscribe link, and the message
 * carries both `List-Unsubscribe` headers (RFC 8058 one-click). The subject
 * holds no line break.
 */
export function buildNotificationEmail(
  input: NotificationEmailInput,
): EmailMessage {
  const { title, lines } = describeChange(input.source);
  const subject = `[${input.orgName}] ${title}`;

  return {
    to: input.to,
    subject: oneLine(subject),
    text: [
      ...lines,
      '',
      `Status page: ${input.publicBaseUrl}/status/${input.orgSlug}`,
      '',
      `To stop these emails, unsubscribe: ${input.unsubscribeUrl}`,
      '',
    ].join('\n'),
    headers: {
      'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
