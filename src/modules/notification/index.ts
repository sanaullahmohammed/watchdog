import type { EmailSender } from '@/modules/notification/domain/email-sender.port';

declare global {
  export interface Dependencies {
    /**
     * The SMTP sender, built from `env.email` (story 6.2). Registered in
     * `src/server/di/index.ts`, because its file name matches none of the
     * container's `loadModules` globs.
     */
    emailSender: EmailSender;
  }
}
