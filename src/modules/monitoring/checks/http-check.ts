import http from 'node:http';
import https from 'node:https';
import type { AllowedCidr } from '@/config/allowed-cidrs';
import {
  KEYWORD_BODY_CAP_BYTES,
  MAX_REDIRECTS,
} from '../domain/monitor-limits';
import type { HostLookup } from '../domain/target-safety';
import {
  CheckError,
  type CheckOutcome,
  codeForNodeError,
  type HttpCheckMetadata,
  type KeywordCheckMetadata,
  messageOf,
  truncateMessage,
} from './check-outcome';
import { guardTarget } from './guarded-connect';

export interface HttpCheckOptions {
  timeoutSeconds: number;
  /** Required: the check reads no configuration. */
  allowedRanges: readonly AllowedCidr[];
  lookup?: HostLookup;
}

const USER_AGENT = 'WatchDog-Monitor/1.0';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function requestHop(
  url: URL,
  options: HttpCheckOptions,
  signal: AbortSignal,
  redirect: boolean,
): Promise<{ response: http.IncomingMessage; agent: http.Agent }> {
  const guarded = await guardTarget(url, {
    allowedRanges: options.allowedRanges,
    lookup: options.lookup,
    signal,
    redirect,
  });
  // A fresh agent per request: nothing is pooled across checks, and an
  // environment proxy only ever applies to the global agent.
  const agent =
    url.protocol === 'https:'
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        agent,
        method: 'GET',
        signal,
        lookup: guarded.lookup as never,
        headers: { 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
      },
      (response) => resolve({ response, agent }),
    );
    request.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    request.end();
  });
}

/** Reads up to the cap, then destroys the response. */
function readCapped(
  response: http.IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      response.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    response.on('data', (chunk: Buffer) => {
      const room = KEYWORD_BODY_CAP_BYTES - total;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.length, room);
      if (total >= KEYWORD_BODY_CAP_BYTES) finish();
    });
    response.on('end', () => finish());
    response.on('error', (error) => finish(error));
    response.on('close', () => {
      if (!response.complete && !done) {
        finish(new Error('connection closed before the body ended'));
      }
    });
    signal.addEventListener(
      'abort',
      () => finish(new CheckError('timeout', 'the check timed out')),
      {
        once: true,
      },
    );
  });
}

/**
 * The shared request path. With `keyword` it also reads the body, capped.
 * Never throws: every failure is an outcome.
 */
export async function runHttpRequestCheck(
  target: string,
  options: HttpCheckOptions,
  keyword?: string,
): Promise<CheckOutcome<KeywordCheckMetadata>> {
  const checkedAt = new Date();
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutSeconds * 1000,
  );
  const metadata: KeywordCheckMetadata = {
    statusCode: null,
    redirects: 0,
    bytesRead: 0,
  };
  let latencyMs: number | null = null;
  let agent: http.Agent | undefined;
  let currentHost = '';

  const failure = (
    errorCode: Extract<CheckOutcome, { status: 'failure' }>['errorCode'],
    message: string,
  ): CheckOutcome<KeywordCheckMetadata> => ({
    status: 'failure',
    checkedAt,
    latencyMs,
    errorCode,
    errorMessage: truncateMessage(message),
    metadata,
  });

  try {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new CheckError('target_refused', 'the target is not a valid URL');
    }
    for (;;) {
      agent?.destroy();
      currentHost = url.hostname;
      const hop = await requestHop(
        url,
        options,
        controller.signal,
        metadata.redirects > 0,
      );
      agent = hop.agent;
      const { response } = hop;
      const status = response.statusCode ?? 0;
      metadata.statusCode = status;
      latencyMs = Math.round(performance.now() - started);

      if (REDIRECT_STATUSES.has(status)) {
        response.destroy();
        if (metadata.redirects >= MAX_REDIRECTS) {
          return failure(
            'too_many_redirects',
            `more than ${MAX_REDIRECTS} redirects`,
          );
        }
        const location = response.headers.location;
        let next: URL | undefined;
        try {
          next = location ? new URL(location, url) : undefined;
        } catch {
          next = undefined;
        }
        if (
          !next ||
          (next.protocol !== 'http:' && next.protocol !== 'https:') ||
          next.username !== '' ||
          next.password !== ''
        ) {
          return failure(
            'invalid_redirect',
            'the redirect has no usable Location',
          );
        }
        metadata.redirects += 1;
        url = next;
        continue;
      }

      if (status < 200 || status > 299) {
        response.destroy();
        return failure('http_status', `HTTP ${status}`);
      }
      if (keyword === undefined) {
        response.destroy();
        return {
          status: 'success',
          checkedAt,
          latencyMs,
          errorCode: null,
          errorMessage: null,
          metadata,
        };
      }

      latencyMs = null;
      const body = await readCapped(response, controller.signal);
      latencyMs = Math.round(performance.now() - started);
      metadata.bytesRead = body.length;
      if (!body.toString('utf8').includes(keyword)) {
        return failure(
          'keyword_missing',
          `keyword not found in the first ${body.length} bytes`,
        );
      }
      return {
        status: 'success',
        checkedAt,
        latencyMs,
        errorCode: null,
        errorMessage: null,
        metadata,
      };
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return failure('timeout', 'the check timed out');
    }
    return failure(codeForNodeError(error), messageOf(error, currentHost));
  } finally {
    clearTimeout(timer);
    agent?.destroy();
  }
}

export async function runHttpCheck(
  target: string,
  options: HttpCheckOptions,
): Promise<CheckOutcome<HttpCheckMetadata>> {
  const outcome = await runHttpRequestCheck(target, options);
  const { bytesRead: _bytesRead, ...metadata } = outcome.metadata;
  return { ...outcome, metadata };
}
