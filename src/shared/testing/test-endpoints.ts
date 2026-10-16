import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Socket,
} from 'node:net';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';

/**
 * One local HTTP server on 127.0.0.1 for check suites, counting what reaches
 * it. Routes:
 *   /ok               200
 *   /error            503
 *   /silent           accepts the request and never answers
 *   /chain/<n>        302 to /chain/<n-1>; /chain/0 answers 200
 *   /redirect-to?url= 302 to the given URL
 *   /stall            200 headers, then a body that never arrives
 *   /delayed-body?delay=ms  200 headers, the body after the delay
 *   /slow-chain/<n>?delay=ms  waits, then 302 to /slow-chain/<n-1>; 0 answers 200
 *   /body?size=&keyword=&at=  `size` bytes of 'a' with the keyword written at
 *                     byte offset `at`
 */
export interface TestEndpoints {
  readonly port: number;
  readonly origin: string;
  /** A port nothing listens on. */
  readonly deadPort: number;
  /** An HTTPS listener whose certificate is self-signed, so untrusted. */
  readonly httpsOrigin: string;
  /** Headers of each request seen, in order. */
  readonly headers: IncomingMessage['headers'][];
  /** Request paths seen, in order. */
  readonly requests: string[];
  /** TCP connections accepted. */
  readonly connections: () => number;
  reset(): void;
  close(): Promise<void>;
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://test.invalid');
  const path = url.pathname;
  if (path === '/ok') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else if (path === '/error') {
    response.writeHead(503).end('unavailable');
  } else if (path === '/silent') {
    // Never answered; closed with the server.
  } else if (path === '/stall') {
    response.writeHead(200).flushHeaders();
  } else if (path === '/delayed-body') {
    response.writeHead(200).flushHeaders();
    setTimeout(
      () => response.end('late body'),
      Number(url.searchParams.get('delay') ?? 0),
    );
  } else if (path.startsWith('/slow-chain/')) {
    const left = Number(path.slice('/slow-chain/'.length));
    const delay = Number(url.searchParams.get('delay') ?? 0);
    setTimeout(() => {
      if (left > 0) {
        response
          .writeHead(302, {
            location: `/slow-chain/${left - 1}?delay=${delay}`,
          })
          .end();
      } else {
        response.writeHead(200).end('end of chain');
      }
    }, delay);
  } else if (path.startsWith('/chain/')) {
    const left = Number(path.slice('/chain/'.length));
    if (left > 0) {
      response.writeHead(302, { location: `/chain/${left - 1}` }).end();
    } else {
      response.writeHead(200).end('end of chain');
    }
  } else if (path === '/redirect-to') {
    response
      .writeHead(302, { location: url.searchParams.get('url') ?? '' })
      .end();
  } else if (path === '/body') {
    const size = Number(url.searchParams.get('size') ?? 0);
    const keyword = url.searchParams.get('keyword') ?? '';
    const at = Number(url.searchParams.get('at') ?? 0);
    const body = Buffer.alloc(size, 'a');
    body.write(keyword, at, 'utf8');
    response
      .writeHead(200, { 'content-length': String(size) })
      .end(body.subarray(0, size));
  } else {
    response.writeHead(404).end();
  }
}

export async function startTestEndpoints(): Promise<TestEndpoints> {
  const requests: string[] = [];
  const headers: IncomingMessage['headers'][] = [];
  let connections = 0;
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    headers.push(request.headers);
    handle(request, response);
  });
  const secure = createSecureServer(
    {
      key: readFileSync(join(__dirname, 'test-tls-key.pem')),
      cert: readFileSync(join(__dirname, 'test-tls-cert.pem')),
    },
    (_request, response) => {
      response.writeHead(200).end('secure');
    },
  );
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
  const deadPort = (spare.address() as AddressInfo).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    deadPort,
    httpsOrigin: `https://127.0.0.1:${(secure.address() as AddressInfo).port}`,
    headers,
    requests,
    connections: () => connections,
    reset() {
      requests.length = 0;
      headers.length = 0;
      connections = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        secure.close();
        secure.closeAllConnections();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface LocalServer {
  readonly port: number;
  /** Server-side SNI of each TLS connection (`false` when none was sent). */
  readonly servernames: (string | false)[];
  /** TCP connections accepted. */
  connections(): number;
  close(): Promise<void>;
}

/** A TLS server on 127.0.0.1 presenting the given certificate. */
export async function startTlsServer(credentials: {
  certPem: string;
  keyPem: string;
}): Promise<LocalServer> {
  let connections = 0;
  const servernames: (string | false)[] = [];
  const sockets = new Set<Socket>();
  // The client may destroy the socket before the server's handshake finishes,
  // so the name is read from the ClientHello, which always arrives.
  const server = createTlsServer(
    {
      cert: credentials.certPem,
      key: credentials.keyPem,
      SNICallback: (name, done) => {
        servernames[servernames.length - 1] = name;
        done(null, undefined);
      },
    },
    (socket) => {
      socket.on('error', () => {});
      socket.end();
    },
  );
  server.on('connection', (socket) => {
    connections += 1;
    servernames.push(false);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    servernames,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A TCP server that accepts connections and never sends a byte. */
export async function startSilentTcpServer(): Promise<LocalServer> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    servernames: [],
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const UNANSWERED_CHILD = `
const net = require('node:net');
const fs = require('node:fs');
const server = net.createServer();
server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
  fs.writeSync(1, String(server.address().port) + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  process.exit(0);
});
`;

/**
 * A port whose TCP handshake never completes. A child process listens with a
 * backlog of 1 and then blocks its event loop, so it never accepts; once the
 * kernel's accept queue is full, Linux drops further SYNs and a client waits
 * for its own deadline. Linux only. The child exits by itself after 120 s.
 */
export async function startUnansweredTcpPort(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const child = spawn(process.execPath, ['-e', UNANSWERED_CHILD], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(Number(text.trim()));
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('port holder exited early')));
  });

  const fillers: Socket[] = [];
  for (let i = 0; i < 20; i += 1) {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    fillers.push(socket);
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!connected) {
      return {
        port,
        close: async () => {
          for (const filler of fillers) filler.destroy();
          child.kill('SIGKILL');
        },
      };
    }
  }
  for (const filler of fillers) filler.destroy();
  child.kill('SIGKILL');
  throw new Error('the accept queue never filled');
}
