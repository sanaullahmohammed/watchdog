import { ERROR_MESSAGE_MAX } from '../domain/monitor-limits';

/**
 * What a check returns. The adapters write nothing; story 5.6 records it.
 */
export const CHECK_ERROR_CODES = [
  'target_refused',
  'too_many_redirects',
  'invalid_redirect',
  'timeout',
  'dns_failure',
  'connection_refused',
  'tls_error',
  'connection_error',
  'http_status',
  'keyword_missing',
  'certificate_untrusted',
  'certificate_hostname_mismatch',
  'certificate_expired',
  'certificate_not_yet_valid',
] as const;

export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

export interface HttpCheckMetadata {
  /** The last status received, or null when none was. */
  statusCode: number | null;
  /** Redirects followed. */
  redirects: number;
}

export interface KeywordCheckMetadata extends HttpCheckMetadata {
  bytesRead: number;
}

export type TcpCheckMetadata = Record<string, never>;

export interface SslExpiryCheckMetadata {
  /** SHA-256 of the leaf's DER, uppercase colon-separated hex. */
  certificateFingerprint: string | null;
  /** The leaf's not-after, ISO 8601 UTC. */
  certificateExpiresAt: string | null;
  /** Whole days, floored; negative once expired. */
  daysRemaining: number | null;
}

export type CheckOutcome<M = HttpCheckMetadata> =
  | {
      status: 'success';
      checkedAt: Date;
      latencyMs: number | null;
      errorCode: null;
      errorMessage: null;
      metadata: M;
    }
  | {
      status: 'failure';
      checkedAt: Date;
      latencyMs: number | null;
      errorCode: CheckErrorCode;
      errorMessage: string;
      metadata: M;
    };

export function truncateMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX
    ? message.slice(0, ERROR_MESSAGE_MAX)
    : message;
}

/** A failure the adapter itself decided on, carrying its code. */
export class CheckError extends Error {
  constructor(
    readonly code: CheckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckError';
  }
}

const TLS_CODE = /^(CERT_|UNABLE_TO_|ERR_TLS_|ERR_SSL_)|SELF_SIGNED_/;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string') return code;
  // A connection attempt across several addresses reports them together.
  const inner = (error as { errors?: unknown }).errors;
  return Array.isArray(inner) ? codeOf(inner[0]) : undefined;
}

/** Maps a Node socket, TLS or parser error to a code. */
export function codeForNodeError(error: unknown): CheckErrorCode {
  if (error instanceof CheckError) return error.code;
  const code = codeOf(error);
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code !== undefined && TLS_CODE.test(code)) return 'tls_error';
  // A handshake OpenSSL rejects (a TLS client reaching a plain-text server)
  // surfaces as EPROTO with the library in its message, not as an ERR_SSL_* code.
  if (
    code === 'EPROTO' &&
    error instanceof Error &&
    error.message.includes('SSL routines')
  ) {
    return 'tls_error';
  }
  return 'connection_error';
}

/**
 * A message for a socket, TLS or parser error built from its code and the
 * host, never from Node's text, which names the dialled address and port.
 */
export function messageOf(error: unknown, host: string): string {
  if (error instanceof CheckError) return truncateMessage(error.message);
  const code = codeOf(error);
  const kind = codeForNodeError(error) === 'tls_error' ? 'TLS' : 'connect';
  return truncateMessage(`${kind} ${code ?? 'error'} to host ${host}`);
}
