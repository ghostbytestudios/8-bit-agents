import type { Envelope } from '@harness/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketFeed, probe, type SocketLike } from './socketFeed';

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  serverSays(message: unknown) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const feed = new SocketFeed('ws://test/ws', () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return { feed, sockets };
}

const envelope = (seq: number): Envelope => ({ id: `r-${seq}`, runId: 'r', ts: seq, seq, event: { type: 'run.started', goal: 'g' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('SocketFeed', () => {
  it('goes live on hello and delivers replayed and live events in order', () => {
    const { feed, sockets } = harness();
    const received: unknown[] = [];
    const statuses: string[] = [];
    feed.subscribe((raw) => received.push(raw));
    feed.onStatus((status) => statuses.push(status));
    feed.connect();

    sockets[0].serverSays({ type: 'hello', protocolVersion: 1, runId: 'r' });
    sockets[0].serverSays({ type: 'replay', envelopes: [envelope(1), envelope(2)] });
    sockets[0].serverSays({ type: 'event', envelope: envelope(3) });

    expect(statuses).toEqual(['live']);
    expect(received.map((raw) => (raw as Envelope).seq)).toEqual([1, 2, 3]);
  });

  it('ignores anything that is not a valid server message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, sockets } = harness();
    const received: unknown[] = [];
    feed.subscribe((raw) => received.push(raw));
    feed.connect();

    sockets[0].serverSays('<script>');
    sockets[0].serverSays({ type: 'event', envelope: { seq: 'nope' } });
    sockets[0].serverSays({ type: 'shutdown' });

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('wraps commands with an id and reports acks', () => {
    const { feed, sockets } = harness();
    const acks: unknown[] = [];
    feed.onAck((ack) => acks.push(ack));
    feed.connect();

    expect(feed.send({ type: 'run.start', goal: 'Build it' })).toBe(true);
    const sent = JSON.parse(sockets[0].sent[0]);
    expect(sent).toMatchObject({ type: 'command', command: { type: 'run.start', goal: 'Build it' } });
    expect(sent.commandId).toMatch(/^[0-9a-f-]{36}$/);

    sockets[0].serverSays({ type: 'ack', commandId: sent.commandId, ok: false, error: 'busy' });
    expect(acks).toEqual([{ type: 'ack', commandId: sent.commandId, ok: false, error: 'busy' }]);
  });

  it('refuses to send while disconnected and reconnects with backoff', () => {
    vi.useFakeTimers();
    const { feed, sockets } = harness();
    const statuses: string[] = [];
    feed.onStatus((status) => statuses.push(status));
    feed.connect();
    sockets[0].serverSays({ type: 'hello', protocolVersion: 1, runId: null });

    sockets[0].drop();
    expect(feed.send({ type: 'run.start', goal: 'x' })).toBe(false);
    expect(statuses).toEqual(['live', 'reconnecting']);

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1].serverSays({ type: 'hello', protocolVersion: 1, runId: null });
    expect(statuses.at(-1)).toBe('live');
  });
});

describe('probe', () => {
  it('returns null when no server says hello in time', async () => {
    vi.useFakeTimers();
    const pending = probe('ws://test/ws', 1_000, () => new FakeSocket());
    vi.advanceTimersByTime(1_000);
    expect(await pending).toBeNull();
  });

  it('returns the live feed once the server says hello', async () => {
    let socket: FakeSocket | null = null;
    const pending = probe('ws://test/ws', 1_000, () => (socket = new FakeSocket()));
    (socket as unknown as FakeSocket).serverSays({ type: 'hello', protocolVersion: 1, runId: null });
    expect(await pending).toBeInstanceOf(SocketFeed);
  });
});
