/**
 * The confirmation emails in flight (story 6.3). The route answers before the
 * send finishes, so the send is tracked here and `drain()` lets shutdown, and a
 * test, wait for it. Touches no database: the connection may close beside
 * `fastify.close()`.
 */
export default function confirmationSendsService({ logger }: Dependencies) {
  const inFlight = new Set<Promise<void>>();

  return {
    track(send: Promise<unknown>): void {
      // An unexpected rejection is a server fault. It is logged without the
      // error, whose message could carry the address or the token.
      const tracked: Promise<void> = send
        .then(
          () => undefined,
          () => {
            logger.error('confirmation email send failed unexpectedly');
          },
        )
        .finally(() => {
          inFlight.delete(tracked);
        });
      inFlight.add(tracked);
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}
