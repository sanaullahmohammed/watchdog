import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import tls from 'node:tls';
import {
  CheckError,
  type CheckErrorCode,
  type CheckOutcome,
  codeForNodeError,
  messageOf,
  type SslExpiryCheckMetadata,
  truncateMessage,
} from './check-outcome';
import { guardHost, parseCheckTarget } from './guarded-connect';
import type { HttpCheckOptions } from './http-check';

export interface SslExpiryCheckOptions extends HttpCheckOptions {
  /** Replaces Node's default roots. For tests only. */
  ca?: string | Buffer;
}

const DAY_MS = 86_400_000;

/** Whole days from `checkedAt` to `notAfter`, floored; negative once past. */
export function daysRemaining(notAfter: Date, checkedAt: Date): number {
  return Math.floor((notAfter.getTime() - checkedAt.getTime()) / DAY_MS);
}

const NO_CERTIFICATE: SslExpiryCheckMetadata = {
  certificateFingerprint: null,
  certificateExpiresAt: null,
  daysRemaining: null,
};

type Retrieved = {
  certificate: X509Certificate;
  authorizationError: string | null;
  latencyMs: number;
};

function codeForAuthorization(
  authorizationError: string,
): Extract<CheckErrorCode, `certificate_${string}`> {
  switch (authorizationError) {
    case 'CERT_HAS_EXPIRED':
      return 'certificate_expired';
    case 'CERT_NOT_YET_VALID':
      return 'certificate_not_yet_valid';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'certificate_hostname_mismatch';
    default:
      return 'certificate_untrusted';
  }
}

/**
 * Retrieves the leaf certificate whether or not it validates, then judges it.
 * Fails only when there is no certificate or it is invalid. Never throws.
 */
export async function runSslExpiryCheck(
  target: string,
  options: SslExpiryCheckOptions,
): Promise<CheckOutcome<SslExpiryCheckMetadata>> {
  const checkedAt = new Date();
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutSeconds * 1000,
  );
  let socket: tls.TLSSocket | undefined;
  let host = '';

  const failure = (
    errorCode: Extract<CheckOutcome, { status: 'failure' }>['errorCode'],
    message: string,
    latencyMs: number | null = null,
    metadata: SslExpiryCheckMetadata = NO_CERTIFICATE,
  ): CheckOutcome<SslExpiryCheckMetadata> => ({
    status: 'failure',
    checkedAt,
    latencyMs,
    errorCode,
    errorMessage: truncateMessage(message),
    metadata,
  });

  try {
    const parsed = parseCheckTarget('ssl_expiry', target);
    host = parsed.host;
    const guarded = await guardHost(host, {
      allowedRanges: options.allowedRanges,
      lookup: options.lookup,
      signal: controller.signal,
      redirect: false,
    });
    const retrieved = await new Promise<Retrieved>((resolve, reject) => {
      const connection = tls.connect({
        host,
        port: parsed.port,
        lookup: guarded.lookup as never,
        servername: isIP(host) !== 0 ? undefined : host,
        rejectUnauthorized: false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      socket = connection;
      connection.once('error', reject);
      controller.signal.addEventListener(
        'abort',
        () => reject(new CheckError('timeout', 'the check timed out')),
        { once: true },
      );
      connection.once('secureConnect', () => {
        const latencyMs = Math.round(performance.now() - started);
        const raw = connection.getPeerCertificate().raw;
        if (!raw || raw.length === 0) {
          reject(
            new CheckError('tls_error', `no certificate from host ${host}`),
          );
          return;
        }
        let certificate: X509Certificate;
        try {
          certificate = new X509Certificate(raw);
        } catch {
          reject(
            new CheckError(
              'tls_error',
              `unreadable certificate from host ${host}`,
            ),
          );
          return;
        }
        resolve({
          certificate,
          authorizationError: connection.authorized
            ? null
            : String(connection.authorizationError),
          latencyMs,
        });
      });
    });

    const notAfter = retrieved.certificate.validToDate;
    const metadata: SslExpiryCheckMetadata = {
      certificateFingerprint: retrieved.certificate.fingerprint256,
      certificateExpiresAt: notAfter.toISOString(),
      daysRemaining: daysRemaining(notAfter, checkedAt),
    };
    if (retrieved.authorizationError !== null) {
      return failure(
        codeForAuthorization(retrieved.authorizationError),
        `certificate for host ${host} is not valid: ${retrieved.authorizationError}`,
        retrieved.latencyMs,
        metadata,
      );
    }
    return {
      status: 'success',
      checkedAt,
      latencyMs: retrieved.latencyMs,
      errorCode: null,
      errorMessage: null,
      metadata,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return failure('timeout', 'the check timed out');
    }
    return failure(codeForNodeError(error), messageOf(error, host));
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
