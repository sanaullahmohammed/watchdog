import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { AllowedCidr } from '@/config/allowed-cidrs';
import { InvalidMonitorInputError } from './monitor.errors';
import type { MonitorType } from './monitor.types';

/**
 * Configure-time target check, ARCHITECTURE 6.5. A courtesy only: DNS can
 * change after this runs, and story 5.4's connect-time guard is the guard.
 * Ranges the rule deliberately leaves unclassified are listed there.
 */

export interface ParsedTarget {
  /** Host without IPv6 brackets, lower-cased, without a trailing dot. */
  host: string;
  port?: number;
}

/**
 * Resolves a host to every address it has. Rejects when it cannot. Must stop
 * its work when `signal` aborts, which the time limit does.
 */
export type HostLookup = (
  host: string,
  signal: AbortSignal,
) => Promise<string[]>;

export const LOOKUP_TIMEOUT_MS = 5_000;

const refuse = (message: string, field = 'target'): never => {
  throw new InvalidMonitorInputError([{ field, message }]);
};

function parsePort(text: string): number | undefined {
  const port = Number(text);
  return /^\d{1,5}$/.test(text) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

const LABEL = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const UNSAFE_CHARACTERS = /[\s\p{Cc}]/u;
// What a name may be made of before URL normalisation. Anything else (`@`, `/`,
// `?`, `#`, `\`) would be consumed by the URL parser as userinfo or a path, so
// the host checked would not be the host written. Non-ASCII letters are left to
// the parser, which punycodes them.
const HOST_CHARACTERS = /^[\p{L}\p{N}._-]+$/u;

/**
 * One reading of a host for every type: an IPv4 address written in any WHATWG
 * form (`127.1`, `2130706433`, `0x7f.1`) becomes its dotted quad, a name is
 * returned punycoded and must have 1-63 character labels, none empty, and at
 * most one trailing dot is dropped. Returns undefined for anything else.
 */
function cleanHost(host: string, bracketed = false): string | undefined {
  const lower = host.toLowerCase();
  if (bracketed) return isIP(lower) === 6 ? lower : undefined;
  if (isIP(lower) !== 0) return lower;
  const bare = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (bare === '' || !HOST_CHARACTERS.test(bare)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(`http://${bare}/`).hostname;
  } catch {
    return undefined;
  }
  if (isIP(hostname) === 4) return hostname;
  if (hostname.length > 253) return undefined;
  return hostname
    .split('.')
    .every((label) => label.length <= 63 && LABEL.test(label))
    ? hostname
    : undefined;
}

/** `host`, `host:port`, `[v6]` or `[v6]:port`. IPv6 must be bracketed. */
function splitHostPort(
  text: string,
  portRequired: boolean,
): ParsedTarget | undefined {
  let rawHost: string;
  let portText: string | undefined;

  if (text.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
    if (!match || match[1]?.includes('%') || isIP(match[1] as string) !== 6) {
      return undefined;
    }
    rawHost = match[1] as string;
    portText = match[2];
  } else {
    const parts = text.split(':');
    if (parts.length > 2) return undefined;
    rawHost = parts[0] as string;
    portText = parts[1];
  }

  const host = cleanHost(rawHost, text.startsWith('['));
  if (host === undefined) return undefined;
  if (portText === undefined) {
    return portRequired ? undefined : { host };
  }
  const port = parsePort(portText);
  return port === undefined ? undefined : { host, port };
}

/**
 * Checks the target's shape for its type and returns the host to check.
 * Throws a 400 naming `target`.
 */
export function parseTarget(type: MonitorType, target: string): ParsedTarget {
  // The stored string must be the validated one, so nothing a URL parser or a
  // resolver would quietly strip is accepted.
  if (UNSAFE_CHARACTERS.test(target)) {
    return refuse('must not contain whitespace or control characters');
  }
  switch (type) {
    case 'http':
    case 'keyword': {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        return refuse('must be an absolute http or https URL');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return refuse('must be an absolute http or https URL');
      }
      if (url.username !== '' || url.password !== '') {
        return refuse('must not contain a username or password');
      }
      if (url.hostname === '') {
        return refuse('must be an absolute http or https URL');
      }
      if (url.port === '0') {
        return refuse('must not use port 0');
      }
      // WHATWG parsing has already normalised decimal, hex and short IPv4
      // forms to dotted quads, so a disguised address classifies as itself.
      const host = cleanHost(url.hostname.replace(/^\[|\]$/g, ''));
      return host === undefined
        ? refuse('must be an absolute http or https URL')
        : { host };
    }
    case 'tcp': {
      const parsed = splitHostPort(target, true);
      return (
        parsed ??
        refuse(
          'must be host:port with a port from 1 to 65535 (IPv6 hosts in brackets)',
        )
      );
    }
    case 'ssl_expiry': {
      const parsed = splitHostPort(target, false);
      return (
        parsed ??
        refuse(
          'must be a host or host:port with a port from 1 to 65535 (IPv6 hosts in brackets)',
        )
      );
    }
  }
}

type Blocked = {
  reason: string;
  list: BlockList;
};

function listOf(
  family: 'ipv4' | 'ipv6',
  ranges: Array<[string, number]>,
): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of ranges) {
    list.addSubnet(address, prefix, family);
  }
  return list;
}

// Order matters for IPv6: ::1 is loopback before it is inside ::/96.
const BLOCKED_V4: Blocked[] = [
  { reason: 'loopback', list: listOf('ipv4', [['127.0.0.0', 8]]) },
  {
    reason: 'private',
    list: listOf('ipv4', [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
    ]),
  },
  { reason: 'link-local', list: listOf('ipv4', [['169.254.0.0', 16]]) },
  { reason: 'unspecified', list: listOf('ipv4', [['0.0.0.0', 8]]) },
  { reason: 'broadcast', list: listOf('ipv4', [['255.255.255.255', 32]]) },
  { reason: 'multicast', list: listOf('ipv4', [['224.0.0.0', 4]]) },
];

const BLOCKED_V6: Blocked[] = [
  { reason: 'loopback', list: listOf('ipv6', [['::1', 128]]) },
  { reason: 'private', list: listOf('ipv6', [['fc00::', 7]]) },
  { reason: 'link-local', list: listOf('ipv6', [['fe80::', 10]]) },
  // ::/96 holds the unspecified address and the deprecated IPv4-compatible
  // form, ::a.b.c.d.
  { reason: 'unspecified', list: listOf('ipv6', [['::', 96]]) },
  { reason: 'multicast', list: listOf('ipv6', [['ff00::', 8]]) },
];

const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, or the address itself.
 * Round-tripping through URL compresses any spelling to one canonical form and
 * turns a dotted tail into hex.
 */
function normalise(raw: string): { address: string; family: 4 | 6 } {
  // A resolver may append a zone to a link-local address (`fe80::1%eth0`),
  // which URL parsing refuses; the zone does not change the classification.
  const address = raw.replace(/%.*$/, '');
  if (isIP(address) === 4) return { address, family: 4 };
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = MAPPED.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1] as string, 16);
    const low = Number.parseInt(mapped[2] as string, 16);
    return {
      address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      family: 4,
    };
  }
  return { address: canonical, family: 6 };
}

/** The reason an address is blocked, or null. Allowed ranges are not applied. */
export function classifyAddress(address: string): string | null {
  const { address: normal, family } = normalise(address);
  const blocked = family === 4 ? BLOCKED_V4 : BLOCKED_V6;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  for (const { reason, list } of blocked) {
    if (list.check(normal, type)) return reason;
  }
  return null;
}

function allowedList(ranges: readonly AllowedCidr[]): BlockList {
  const list = new BlockList();
  for (const { address, prefix, family } of ranges) {
    list.addSubnet(address, prefix, family);
  }
  return list;
}

/**
 * Resolves with the system's DNS servers through a `Resolver`, whose queries
 * can be cancelled. `dns.lookup` cannot: it holds a libuv threadpool thread
 * until the OS resolver gives up, however early the caller stops waiting.
 */
const defaultLookup: HostLookup = async (host, signal) => {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
  signal.addEventListener('abort', () => resolver.cancel(), { once: true });
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ]);
  if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason;
  return [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
};

export interface TargetCheckOptions {
  allowedRanges?: readonly AllowedCidr[];
  lookup?: HostLookup;
  lookupTimeoutMs?: number;
}

/** Resolves to the addresses, or null when the lookup failed or timed out. */
async function resolve(
  host: string,
  lookup: HostLookup,
  timeoutMs: number,
): Promise<string[] | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => {
      controller.abort();
      done(null);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      lookup(host, controller.signal).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuses a target whose host is, or resolves to, a blocked address, unless the
 * address lies inside an allowed range. `localhost` and `*.localhost` count as
 * 127.0.0.1 and ::1 without a lookup, and the allowed list applies to them like
 * any address. A refusal names the host and the reason, never an address that
 * came from a lookup. A lookup that fails or exceeds the timeout accepts: the
 * connect-time guard is the guard.
 */
export async function assertTargetAllowed(
  type: MonitorType,
  target: string,
  options: TargetCheckOptions = {},
): Promise<void> {
  const { host } = parseTarget(type, target);
  const allowed = allowedList(options.allowedRanges ?? []);

  const isAllowed = (address: string) => {
    const { address: normal, family } = normalise(address);
    return allowed.check(normal, family === 4 ? 'ipv4' : 'ipv6');
  };

  const check = (address: string, resolved: boolean) => {
    const reason = classifyAddress(address);
    if (reason && !isAllowed(address)) {
      refuse(
        resolved
          ? `host ${host} resolves to a ${reason} address, which monitors may not check unless it is listed in MONITOR_ALLOWED_CIDRS`
          : `host ${host} is a ${reason} address, which monitors may not check unless it is listed in MONITOR_ALLOWED_CIDRS`,
      );
    }
  };

  if (host === 'localhost' || host.endsWith('.localhost')) {
    for (const address of ['127.0.0.1', '::1']) {
      if (classifyAddress(address) && !isAllowed(address)) {
        refuse(
          `host ${host} is a loopback name, which monitors may not check unless 127.0.0.1 and ::1 are listed in MONITOR_ALLOWED_CIDRS`,
        );
      }
    }
    return;
  }

  if (isIP(host) !== 0) {
    check(host, false);
    return;
  }

  const addresses = await resolve(
    host,
    options.lookup ?? defaultLookup,
    options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS,
  );
  for (const address of addresses ?? []) {
    check(address, true);
  }
}
