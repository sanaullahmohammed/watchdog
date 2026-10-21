/** One parsed log line, with the fields the suites read. */
export type LogEntry = {
  level: number;
  msg: string;
  reqId?: string;
  correlationId?: string;
  statusCode?: number;
  err?: Record<string, unknown> & { stack?: string };
  [key: string]: unknown;
};

/**
 * A log destination for a test: hand `stream` to a logger, as
 * `buildApp({ logger: { level, stream } })` or `pino(options, stream)`, then
 * read back what it wrote. `lines` is every raw line, in order, so a test can
 * search the exact text a log file would hold; `entries()` parses them.
 */
export function captureLogs() {
  const lines: string[] = [];
  return {
    stream: {
      write: (line: string) => {
        lines.push(line);
      },
    },
    lines,
    entries: (): LogEntry[] => lines.map((line) => JSON.parse(line)),
  };
}
