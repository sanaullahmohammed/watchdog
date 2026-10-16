import net from 'node:net';
import {
  CheckError,
  type CheckOutcome,
  codeForNodeError,
  messageOf,
  type TcpCheckMetadata,
  truncateMessage,
} from './check-outcome';
import { guardHost, parseCheckTarget } from './guarded-connect';
import type { HttpCheckOptions } from './http-check';

export type TcpCheckOptions = HttpCheckOptions;

/**
 * Succeeds when the TCP connection is established, then destroys it. A server
 * that accepts and stays silent is a success. Never throws.
 */
export async function runTcpCheck(
  target: string,
  options: TcpCheckOptions,
): Promise<CheckOutcome<TcpCheckMetadata>> {
  const checkedAt = new Date();
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutSeconds * 1000,
  );
  let socket: net.Socket | undefined;
  let host = '';

  const failure = (
    errorCode: Extract<CheckOutcome, { status: 'failure' }>['errorCode'],
    message: string,
  ): CheckOutcome<TcpCheckMetadata> => ({
    status: 'failure',
    checkedAt,
    latencyMs: null,
    errorCode,
    errorMessage: truncateMessage(message),
    metadata: {},
  });

  try {
    const parsed = parseCheckTarget('tcp', target);
    host = parsed.host;
    const guarded = await guardHost(host, {
      allowedRanges: options.allowedRanges,
      lookup: options.lookup,
      signal: controller.signal,
      redirect: false,
    });
    const latencyMs = await new Promise<number>((resolve, reject) => {
      const connection = net.connect({
        host,
        port: parsed.port,
        lookup: guarded.lookup as never,
      });
      socket = connection;
      connection.once('connect', () =>
        resolve(Math.round(performance.now() - started)),
      );
      connection.once('error', reject);
      controller.signal.addEventListener(
        'abort',
        () => reject(new CheckError('timeout', 'the check timed out')),
        { once: true },
      );
    });
    return {
      status: 'success',
      checkedAt,
      latencyMs,
      errorCode: null,
      errorMessage: null,
      metadata: {},
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
