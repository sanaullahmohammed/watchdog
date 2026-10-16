import { isIP } from 'node:net';
import type { AllowedCidr } from '@/config/allowed-cidrs';
import {
  defaultLookup,
  type HostLookup,
  parseTarget,
  refusalReason,
} from '../domain/target-safety';
import { CheckError } from './check-outcome';

/**
 * Connect-time guard, ARCHITECTURE 6.5 (M6). Resolves a URL's host, classifies
 * every address with the rule configure time uses, and hands back a `lookup`
 * for `http.request` that returns only those addresses, so the address
 * classified is the address dialled and nothing resolves twice.
 */

export interface GuardOptions {
  allowedRanges: readonly AllowedCidr[];
  lookup?: HostLookup;
  /** Aborts when the check's deadline fires. */
  signal: AbortSignal;
  /** True for a redirect's target; the refusal message then says so. */
  redirect: boolean;
}

export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean } | number | undefined,
  callback: (...args: unknown[]) => void,
) => void;

export interface GuardedTarget {
  addresses: string[];
  lookup: PinnedLookup;
}

const timedOut = () => new CheckError('timeout', 'the check timed out');

/** Rejects with a timeout when the signal aborts, and never otherwise. */
function onAbort(signal: AbortSignal): {
  promise: Promise<never>;
  stop(): void;
} {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(timedOut());
    listener = () => reject(timedOut());
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    stop: () => listener && signal.removeEventListener('abort', listener),
  };
}

async function resolveAddresses(
  host: string,
  lookup: HostLookup,
  signal: AbortSignal,
): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return ['127.0.0.1', '::1'];
  }
  const abort = onAbort(signal);
  try {
    const addresses = await Promise.race([
      lookup(host, signal).catch((error: unknown) => {
        if (signal.aborted) throw timedOut();
        throw new CheckError(
          'dns_failure',
          `could not resolve host ${host}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }),
      abort.promise,
    ]);
    if (addresses.length === 0) {
      throw new CheckError('dns_failure', `host ${host} has no address`);
    }
    return addresses;
  } finally {
    abort.stop();
  }
}

/**
 * Throws a `CheckError`: `target_refused` when any address is refused,
 * `dns_failure` when the host does not resolve, `timeout` when the deadline
 * fires first.
 */
export async function guardTarget(
  url: URL,
  options: GuardOptions,
): Promise<GuardedTarget> {
  let host: string;
  try {
    host = parseTarget('http', url.href).host;
  } catch {
    throw new CheckError(
      options.redirect ? 'invalid_redirect' : 'target_refused',
      options.redirect
        ? 'redirect to a URL that is not a valid http or https target'
        : 'the target is not a valid http or https URL',
    );
  }
  return guardHost(host, options);
}

/**
 * Resolves and classifies an already-parsed host, then pins the lookup to the
 * addresses that passed. Same errors as `guardTarget`.
 */
export async function guardHost(
  host: string,
  options: GuardOptions,
): Promise<GuardedTarget> {
  const literal =
    isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost');
  const addresses = await resolveAddresses(
    host,
    options.lookup ?? defaultLookup,
    options.signal,
  );
  for (const address of addresses) {
    const reason = refusalReason(address, options.allowedRanges);
    if (reason) {
      // The host is the monitor's own text on the first request and the Location
      // header's on a hop; either way a looked-up address is never named.
      throw new CheckError(
        'target_refused',
        `${options.redirect ? 'redirect to ' : ''}host ${host} ${literal ? 'is' : 'resolves to'} a ${reason} address, which monitors may not check unless it is listed in MONITOR_ALLOWED_CIDRS`,
      );
    }
  }
  const entries = addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  const lookup: PinnedLookup = (_hostname, lookupOptions, callback) => {
    const wantsAll =
      typeof lookupOptions === 'object' && lookupOptions?.all === true;
    if (wantsAll) {
      callback(null, entries);
    } else {
      const [first] = entries;
      callback(null, first?.address, first?.family);
    }
  };
  return { addresses, lookup };
}

/**
 * A tcp or ssl_expiry target as the configure-time parser reads it, so the two
 * times cannot disagree. `ssl_expiry` defaults to port 443. Throws a
 * `target_refused` `CheckError` for a target the parser refuses.
 */
export function parseCheckTarget(
  type: 'tcp' | 'ssl_expiry',
  target: string,
): { host: string; port: number } {
  try {
    const { host, port } = parseTarget(type, target);
    return { host, port: port ?? 443 };
  } catch {
    throw new CheckError(
      'target_refused',
      type === 'tcp'
        ? 'the target is not a valid host:port'
        : 'the target is not a valid host or host:port',
    );
  }
}
