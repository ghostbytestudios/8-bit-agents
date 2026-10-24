import type { HarnessEvent, ServerMessage } from '@harness/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RunHub, type RunHandle } from './hub';
import { TOKEN_HEADER, startServer, type RunningServer } from './server';

const ORIGIN = 'http://localhost:5173';
const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A run that announces itself and then stays active until stopped, like a real one. */
class FakeRun implements RunHandle {
  answers: string[] = [];
  private end: () => void = () => undefined;
  constructor(readonly emit: (event: HarnessEvent) => void) {}
  async start(goal: string) {
    this.emit({ type: 'run.started', goal });
    await new Promise<void>((resolve) => (this.end = resolve));
  }
  stop() {
    this.end();
  }
  respond(_requestId: string, answer: string) {
    this.answers.push(answer);
    return true;
  }
}

let server: RunningServer | null = null;
let lastRun: FakeRun | null = null;

const TOKEN = 'a'.repeat(64);

async function boot() {
  const hub = new RunHub((emit) => (lastRun = new FakeRun(emit)), null, quietLog);
  server = await startServer({ hub, host: '127.0.0.1', port: 0, allowedOrigins: [ORIGIN], sessionToken: TOKEN, log: quietLog });
  return { hub, url: `ws://127.0.0.1:${server.port}/ws` };
}

function open(url: string, origin = ORIGIN, token = TOKEN): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, headers: { [TOKEN_HEADER]: token } });
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('harness server', () => {
  it('refuses browsers from other origins', async () => {
    const { url } = await boot();
    await expect(open(url, 'https://evil.example')).rejects.toThrow(/403|Unexpected server response/);
  });

  it('refuses connections without the session token, even from an allowed origin', async () => {
    const { url } = await boot();
    await expect(open(url, ORIGIN, 'b'.repeat(64))).rejects.toThrow(/403|Unexpected server response/);
    await expect(open(url, ORIGIN, '')).rejects.toThrow(/403|Unexpected server response/);
  });

  it('greets, starts a run, acknowledges commands and streams events', async () => {
    const { url } = await boot();
    const { socket, messages } = await open(url);
    await waitFor(() => messages.find((message) => message.type === 'hello'));

    socket.send(JSON.stringify({ type: 'command', commandId: 'c1', command: { type: 'run.start', goal: 'Build it' } }));
    expect(await waitFor(() => messages.find((message) => message.type === 'ack'))).toEqual({ type: 'ack', commandId: 'c1', ok: true });
    const event = await waitFor(() => messages.find((message) => message.type === 'event'));
    expect(event.type === 'event' && event.envelope).toMatchObject({ seq: 1, event: { type: 'run.started', goal: 'Build it' } });

    socket.send(JSON.stringify({ type: 'command', commandId: 'c2', command: { type: 'run.start', goal: 'Again' } }));
    const second = await waitFor(() => messages.find((message) => message.type === 'ack' && message.commandId === 'c2'));
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining('already in progress') });
    socket.close();
  });

  it('replays the current run to a browser that joins late', async () => {
    const { url } = await boot();
    const first = await open(url);
    first.socket.send(JSON.stringify({ type: 'command', commandId: 'c1', command: { type: 'run.start', goal: 'Build it' } }));
    await waitFor(() => first.messages.find((message) => message.type === 'event'));

    const late = await open(url);
    const replay = await waitFor(() => late.messages.find((message) => message.type === 'replay'));
    expect(replay.type === 'replay' && replay.envelopes.map((envelope) => envelope.event.type)).toEqual(['run.started']);
    first.socket.close();
    late.socket.close();
  });

  it('ignores malformed commands and passes answers to the run', async () => {
    const { url } = await boot();
    const { socket, messages } = await open(url);
    socket.send('not json');
    socket.send(JSON.stringify({ type: 'command', commandId: 'x', command: { type: 'rm -rf' } }));
    socket.send(JSON.stringify({ type: 'command', commandId: 'c1', command: { type: 'run.start', goal: 'g' } }));
    socket.send(JSON.stringify({ type: 'command', commandId: 'c2', command: { type: 'human.respond', requestId: 'ask-1', answer: 'SQLite' } }));
    await waitFor(() => messages.find((message) => message.type === 'ack' && message.commandId === 'c2'));

    expect(messages.filter((message) => message.type === 'ack').map((message) => message.type === 'ack' && message.commandId)).toEqual(['c1', 'c2']);
    expect(lastRun?.answers).toEqual(['SQLite']);
    socket.close();
  });
});
