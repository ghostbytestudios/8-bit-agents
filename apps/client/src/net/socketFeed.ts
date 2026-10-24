import { ServerMessageSchema, type ClientMessage, type EventFeed, type HarnessCommand } from '@harness/protocol';

/**
 * The live feed: a WebSocket to the harness server. Every server message is validated;
 * the socket reconnects with backoff, and the server replays the current run on reconnect,
 * so a dropped connection never loses a question from an agent.
 */

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

export interface Ack {
  commandId: string;
  ok: boolean;
  error?: string;
}

/** Just the part of the browser WebSocket this feed uses (a seam for tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export class SocketFeed implements EventFeed {
  readonly isSimulated = false;
  private socket: SocketLike | null = null;
  private retryMs = MIN_RETRY_MS;
  private isClosed = false;
  private readonly listeners = new Set<(raw: unknown) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly ackListeners = new Set<(ack: Ack) => void>();
  private status: ConnectionStatus = 'connecting';

  constructor(private readonly url: string, private readonly createSocket: SocketFactory = defaultFactory) {}

  get connection(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    this.isClosed = false;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => {
      if (this.socket !== socket || this.isClosed) return;
      this.setStatus('reconnecting');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    };
  }

  close(): void {
    this.isClosed = true;
    this.socket?.close();
    this.socket = null;
  }

  subscribe(listener: (raw: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onAck(listener: (ack: Ack) => void): () => void {
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  /** Sends a command; false (and nothing sent) while disconnected. */
  send(command: HarnessCommand): boolean {
    if (this.socket?.readyState !== OPEN) return false;
    const message: ClientMessage = { type: 'command', commandId: crypto.randomUUID(), command };
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private receive(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      console.warn('[feed] ignored a server message that is not JSON');
      return;
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[feed] ignored an invalid server message', parsed.error.issues.slice(0, 3));
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'hello':
        this.retryMs = MIN_RETRY_MS;
        this.setStatus('live');
        return;
      case 'replay':
        for (const envelope of message.envelopes) this.publish(envelope);
        return;
      case 'event':
        this.publish(message.envelope);
        return;
      case 'ack':
        for (const listener of this.ackListeners) listener(message);
        return;
    }
  }

  private publish(envelope: unknown): void {
    for (const listener of this.listeners) listener(envelope);
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

/**
 * Connects and waits briefly for the server's hello. Resolves with the live feed, or null
 * when no server answers (the caller then falls back to the in-browser mock).
 */
export function probe(url: string, timeoutMs: number, createSocket?: SocketFactory): Promise<SocketFeed | null> {
  const feed = new SocketFeed(url, createSocket);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      feed.close();
      resolve(null);
    }, timeoutMs);
    const stop = feed.onStatus((status) => {
      if (status !== 'live') return;
      clearTimeout(timer);
      stop();
      resolve(feed);
    });
    feed.connect();
  });
}
