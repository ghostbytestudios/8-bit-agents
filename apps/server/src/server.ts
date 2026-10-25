import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClientMessageSchema, type ServerMessage } from '@harness/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { RunHub } from './hub';

/**
 * HTTP + WebSocket front door. Local-only by default: bound to 127.0.0.1 and only
 * browser pages from allowed origins may connect, so a random website you visit can't
 * open a socket to your agents.
 */

/** Fits a full-length skill (16,000 characters, up to 4 bytes each in UTF-8) with JSON escaping. */
const MAX_MESSAGE_BYTES = 192 * 1024;
const MAX_MESSAGES_PER_SECOND = 20;
const HEARTBEAT_MS = 15_000;
/** Close codes: 1003 unsupported data, 1008 policy violation. */
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;

/** Header the Vite dev proxy adds; the browser page itself never sees the token. */
export const TOKEN_HEADER = 'x-harness-token';
const MAX_CLIENTS = 5;

export interface ServerOptions {
  hub: RunHub;
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  /** When set, connections must present it (proves they came through your own dev proxy). */
  sessionToken?: string;
  log?: Pick<Console, 'info' | 'warn'>;
}

function tokenMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function attachClient(socket: WebSocket, hub: RunHub, log: Pick<Console, 'warn'>): void {
  const send = (message: ServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const detach = hub.connect(send);
  let windowStart = Date.now();
  let messagesInWindow = 0;

  socket.on('message', async (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      socket.close(CLOSE_UNSUPPORTED, 'text only');
      return;
    }
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    if (++messagesInWindow > MAX_MESSAGES_PER_SECOND) {
      socket.close(CLOSE_POLICY, 'too many messages');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      log.warn('[ws] ignored a message that is not JSON');
      return;
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('[ws] ignored an invalid command', parsed.error.issues.slice(0, 3));
      return;
    }
    const outcome = await hub.handle(parsed.data.command, send);
    send({ type: 'ack', commandId: parsed.data.commandId, ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) });
  });
  socket.on('close', detach);
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? console;
  const http: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    response.writeHead(404).end();
  });

  const allowed = new Set(options.allowedOrigins);
  const sockets = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
      const refuse = (why: string) => {
        log.warn(`[ws] refused a connection: ${why}`);
        return false;
      };
      if (typeof origin !== 'string' || !allowed.has(origin)) return refuse(`origin ${origin ?? '(none)'} is not allowed`);
      if (options.sessionToken && !tokenMatches(req.headers[TOKEN_HEADER], options.sessionToken)) return refuse('missing or wrong session token');
      if (sockets.clients.size >= MAX_CLIENTS) return refuse(`already ${MAX_CLIENTS} connections`);
      return true;
    },
  });

  const alive = new WeakMap<WebSocket, boolean>();
  sockets.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    attachClient(socket, options.hub, log);
  });
  // Drop connections that stopped answering pings (closed laptop, dead network).
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          for (const socket of sockets.clients) socket.terminate();
          sockets.close(() => http.close(() => done()));
        }),
      });
    });
  });
}
