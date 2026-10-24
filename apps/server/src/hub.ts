import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  type Envelope,
  type HarnessCommand,
  type HarnessEvent,
  type ServerMessage,
} from '@harness/protocol';

/**
 * Sits between browsers and the current run: numbers every event, keeps the run's log
 * so late joiners get a replay, and turns commands into run actions. One run at a time.
 */

const MAX_KEPT_EVENTS = 20_000;

export interface RunHandle {
  start(goal: string): Promise<void>;
  stop(): void;
  respond(requestId: string, answer: string): boolean;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
}

type Send = (message: ServerMessage) => void;
type Logger = Pick<Console, 'warn' | 'error'>;

export class RunHub {
  private envelopes: Envelope[] = [];
  private runId: string | null = null;
  private seq = 0;
  private run: RunHandle | null = null;
  private isRunning = false;
  private readonly clients = new Set<Send>();

  constructor(
    private readonly createRun: (emit: (event: HarnessEvent) => void) => RunHandle,
    private readonly log: Logger = console,
  ) {}

  /** Greets a new client with the current run so far; returns the disconnect function. */
  connect(send: Send): () => void {
    send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, runId: this.runId });
    if (this.envelopes.length) send({ type: 'replay', envelopes: [...this.envelopes] });
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  handle(command: HarnessCommand): CommandOutcome {
    switch (command.type) {
      case 'run.start':
        return this.startRun(command.goal);
      case 'run.stop':
        if (!this.isRunning || command.runId !== this.runId) return { ok: false, error: 'That run is not active.' };
        this.run?.stop();
        return { ok: true };
      case 'human.respond':
        return this.run?.respond(command.requestId, command.answer)
          ? { ok: true }
          : { ok: false, error: 'That question is no longer open.' };
      case 'agent.message':
      case 'agent.pause':
      case 'agent.resume':
      case 'agent.stop':
        return { ok: false, error: 'Talking to, pausing and stopping single agents arrives in Phase 6.' };
    }
  }

  private startRun(goal: string): CommandOutcome {
    if (this.isRunning) return { ok: false, error: 'A run is already in progress. Stop it first.' };
    const runId = `run-${Date.now().toString(36)}`;
    this.runId = runId;
    this.seq = 0;
    this.envelopes = [];
    this.isRunning = true;
    const run = this.createRun((event) => this.publish(runId, event));
    this.run = run;
    run.start(goal)
      .catch((error: unknown) => this.log.error('[hub] run crashed', error))
      .finally(() => {
        if (this.run === run) this.isRunning = false;
      });
    return { ok: true };
  }

  private publish(runId: string, event: HarnessEvent): void {
    if (runId !== this.runId) return; // A stopped run's stragglers.
    this.seq += 1;
    const parsed = EnvelopeSchema.safeParse({ id: `${runId}-${this.seq}`, runId, ts: Date.now(), seq: this.seq, event });
    if (!parsed.success) {
      this.log.warn(`[hub] dropped invalid ${event.type} event`, parsed.error.issues);
      return;
    }
    this.envelopes.push(parsed.data);
    if (this.envelopes.length > MAX_KEPT_EVENTS) this.envelopes.shift();
    for (const send of this.clients) send({ type: 'event', envelope: parsed.data });
  }
}
