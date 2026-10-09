import { isIP } from 'node:net';

export interface AllowedCidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** The address as bytes: 4 for IPv4, 16 for IPv6. */
function bytesOf(address: string, version: number): number[] {
  if (version === 4) return address.split('.').map(Number);
  // URL parsing canonicalises any spelling, turning a dotted tail into hex.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = '', tail] = canonical.split('::');
  const groups = (text: string) => (text === '' ? [] : text.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

/** True when any bit of the address past the first `prefix` bits is set. */
function hasBitsPastPrefix(
  address: string,
  version: number,
  prefix: number,
): boolean {
  return bytesOf(address, version).some((byte, index) => {
    const kept = Math.max(0, Math.min(8, prefix - index * 8));
    return (byte & (0xff >> kept)) !== 0;
  });
}

/**
 * Parses `MONITOR_ALLOWED_CIDRS`: comma-separated CIDR ranges, empty meaning
 * none. An invalid entry throws, naming it, so the process fails at boot
 * rather than silently allowing less (or more) than the operator meant.
 */
export function parseAllowedCidrs(raw: string): AllowedCidr[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [address, prefixText, ...rest] = entry.split('/');
      const version = isIP(address ?? '');
      const valid =
        version !== 0 &&
        rest.length === 0 &&
        prefixText !== undefined &&
        /^\d{1,3}$/.test(prefixText) &&
        Number(prefixText) <= (version === 4 ? 32 : 128) &&
        // Strict CIDR: `::ffff:10.0.0.0/8` is really `::/8`, and would allow
        // far more than it reads as.
        !hasBitsPastPrefix(address as string, version, Number(prefixText));
      if (!valid) {
        throw new Error(
          `MONITOR_ALLOWED_CIDRS has an invalid entry "${entry}"; expected a CIDR such as 10.0.0.0/8 or fd00::/8`,
        );
      }
      return {
        address,
        prefix: Number(prefixText),
        family: version === 4 ? 'ipv4' : 'ipv6',
      } as AllowedCidr;
    });
}
