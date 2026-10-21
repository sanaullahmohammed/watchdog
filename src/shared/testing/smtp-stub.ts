import { createServer, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';

/**
 * A minimal SMTP server on 127.0.0.1 for unit specs (story 6.2). It speaks
 * just enough for nodemailer: a greeting, EHLO advertising `AUTH PLAIN`,
 * AUTH, MAIL FROM, RCPT TO, DATA, RSET and QUIT.
 *
 * Each refusal is the configured code followed by the command's own argument,
 * the way a real server quotes the address it refuses. A diagnostic that
 * leaked the reply text would therefore leak the recipient.
 *
 * Never used to prove delivery: that is Mailpit's job (decision D15).
 */
export type SmtpStubOptions = {
  /** A code to greet with, or `'never'` to accept and stay silent. Default 220. */
  greeting?: number | 'never';
  auth?: number;
  mailFrom?: number;
  rcptTo?: number;
  /** The reply after the message body. */
  data?: number;
  /** Wait this long before every reply, the greeting included. */
  replyDelayMs?: number;
  /** Answer this command (such as `'EHLO'`), then never reply again. */
  silentAfter?: string;
  /**
   * Offer STARTTLS and upgrade with this key and certificate. Without it the
   * stub offers no STARTTLS and answers the command with 502.
   */
  starttls?: { key: string; cert: string };
};

export type SmtpStub = {
  port: number;
  /** Every command line received, in order. */
  commands: string[];
  close(): Promise<void>;
};

const text = (code: number) => (code < 400 ? 'OK' : 'Refused');

export async function startSmtpStub(
  options: SmtpStubOptions = {},
): Promise<SmtpStub> {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const delay = options.replyDelayMs ?? 0;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    // The socket replies go to: the plain one, then the TLS one after an
    // upgrade.
    let conn: Socket = socket;
    const reply = (line: string) => {
      setTimeout(() => {
        if (!conn.destroyed) conn.write(`${line}\r\n`);
      }, delay);
    };
    const coded = (code: number | undefined, fallback: number, arg = '') =>
      reply(`${code ?? fallback} ${text(code ?? fallback)} ${arg}`.trimEnd());

    if (options.greeting !== 'never') {
      coded(
        options.greeting === undefined ? undefined : options.greeting,
        220,
        'stub ESMTP',
      );
    }

    let buffer = '';
    let inData = false;
    let silent = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          coded(options.data, 250, 'queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        commands.push(line);
        const verb = line.split(' ', 1)[0].toUpperCase();
        const arg = line.slice(verb.length).trim();
        if (silent) continue;
        if (verb === options.silentAfter) silent = true;
        if (verb === 'EHLO' || verb === 'HELO') {
          reply('250-stub');
          if (options.starttls && conn === socket) reply('250-STARTTLS');
          reply('250 AUTH PLAIN');
        } else if (verb === 'STARTTLS' && options.starttls && conn === socket) {
          socket.removeListener('data', onData);
          socket.write('220 ready\r\n');
          const secure = new TLSSocket(socket, {
            isServer: true,
            key: options.starttls.key,
            cert: options.starttls.cert,
          });
          secure.on('error', () => {});
          secure.on('data', onData);
          conn = secure;
          buffer = '';
          return;
        } else if (verb === 'AUTH') {
          coded(options.auth, 235, 'authenticated');
        } else if (verb === 'MAIL') {
          coded(options.mailFrom, 250, arg);
        } else if (verb === 'RCPT') {
          coded(options.rcptTo, 250, arg);
        } else if (verb === 'DATA') {
          reply('354 go ahead');
          inData = true;
        } else if (verb === 'RSET' || verb === 'NOOP') {
          reply('250 OK');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          setTimeout(() => conn.end(), delay);
        } else {
          reply('502 unrecognised');
        }
      }
    };
    socket.on('data', onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the SMTP stub has no port');
  }

  return {
    port: address.port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port on 127.0.0.1 that nothing listens on, at least for a moment. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return address.port;
}
