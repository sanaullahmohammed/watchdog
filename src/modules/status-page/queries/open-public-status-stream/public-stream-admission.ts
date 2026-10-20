/**
 * Who may hold a public status stream open (story 4.5, ARCHITECTURE 5.4.1).
 *
 * A stream is long-lived, so the rate limit, which counts openings, does not
 * bound how many are open at once. This does: at most `maxPerIp` from one
 * client IP and `maxTotal` in this process. One per app, so two apps in one
 * process count apart, as their rate-limit buckets do.
 *
 * Synchronous on purpose. The route admits in the same tick as it hijacks the
 * reply, so no other opening can be counted between the check and the place
 * being taken.
 *
 * The key is the socket address: `trustProxy` is off, so behind a reverse
 * proxy every caller shares the proxy's places, as they share its rate-limit
 * bucket (F-18).
 */

/** Gives a place back. Idempotent: a second call changes nothing. */
export type ReleaseStreamPlace = () => void;

export type StreamAdmission = {
  /** Takes a place for `ip`, or answers `undefined` when either cap is full. */
  admit(ip: string): ReleaseStreamPlace | undefined;
  /** How many places are held: in all, or by one IP. */
  open(ip?: string): number;
  /** How many IPs hold a place. An IP whose last place is released is gone. */
  trackedIps(): number;
};

export function createStreamAdmission({
  maxPerIp,
  maxTotal,
}: {
  maxPerIp: number;
  maxTotal: number;
}): StreamAdmission {
  const byIp = new Map<string, number>();
  let total = 0;

  return {
    admit(ip) {
      const held = byIp.get(ip) ?? 0;
      if (held >= maxPerIp || total >= maxTotal) return undefined;

      byIp.set(ip, held + 1);
      total += 1;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (byIp.get(ip) ?? 1) - 1;
        // An IP with no stream open keeps no entry, so the map is bounded by
        // the open streams rather than by every address ever seen.
        if (remaining <= 0) byIp.delete(ip);
        else byIp.set(ip, remaining);
      };
    },

    open(ip) {
      return ip === undefined ? total : (byIp.get(ip) ?? 0);
    },

    trackedIps() {
      return byIp.size;
    },
  };
}
