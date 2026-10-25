import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  type Envelope,
  type HarnessCommand,
  type HarnessEvent,
  type ServerMessage,
} from '@harness/protocol';
import { SettingsError, type SettingsService } from './settings/service';
import { SkillError, type SkillStore } from './skills';
import { WorkspaceError } from './workspace';

/**
 * Sits between browsers and the current run: numbers every event, keeps the run's log
 * so late joiners get a replay, and turns commands into run actions. One run at a time.
 */

const MAX_KEPT_EVENTS = 20_000;
/** Matches the protocol's limits for a connection-test result. */
const MAX_MODEL_ID_CHARS = 128;
const MAX_MODELS = 500;

export interface RunHandle {
  start(goal: string): Promise<void>;
  stop(): void;
  respond(requestId: string, answer: string): boolean;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
}

export interface FileListing {
  root: string;
  entries: string[];
  truncated: boolean;
}

/** The workspace as the War Room's file cabinet sees it: look, don't touch. */
export interface WorkspaceFiles {
  list(): Promise<FileListing>;
  read(path: string): Promise<string>;
}

export interface HubServices {
  settings?: SettingsService;
  files?: WorkspaceFiles;
  skills?: SkillStore;
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
  private readonly settings: SettingsService | null;

  constructor(
    private readonly createRun: (emit: (event: HarnessEvent) => void) => RunHandle,
    private readonly services: HubServices = {},
    private readonly log: Logger = console,
  ) {
    this.settings = services.settings ?? null;
    // Every open window sees settings and skill changes, wherever they were made.
    this.settings?.onChange((snapshot) => this.broadcast({ type: 'settings', ...snapshot }));
    services.skills?.onChange((skills) => this.broadcast({ type: 'skills', skills }));
  }

  /** Greets a new client with settings and the current run so far; returns the disconnect function. */
  connect(send: Send): () => void {
    send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, runId: this.runId });
    if (this.settings) send({ type: 'settings', ...this.settings.snapshot() });
    if (this.envelopes.length) send({ type: 'replay', envelopes: [...this.envelopes] });
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  /** Stops the active run, if any (used when the app shuts down). */
  stopActiveRun(): void {
    if (this.isRunning) this.run?.stop();
  }

  /** `reply` reaches only the client that sent the command (e.g. its connection test result). */
  async handle(command: HarnessCommand, reply: Send = () => undefined): Promise<CommandOutcome> {
    switch (command.type) {
      case 'settings.update':
        return this.withSettings((settings) => settings.update(command.settings));
      case 'provider.setKey':
        return this.withSettings((settings) => settings.setKey(command.providerId, command.key));
      case 'provider.clearKey':
        return this.withSettings((settings) => settings.clearKey(command.providerId));
      case 'provider.test':
        return this.withSettings(async (settings) => {
          const result = await settings.test(command.providerId);
          const models = result.models.filter((model) => model.length <= MAX_MODEL_ID_CHARS).slice(0, MAX_MODELS);
          reply({ type: 'provider.tested', providerId: command.providerId, ok: result.ok, detail: result.detail, models });
        });
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
      case 'files.list':
        return this.withService('files', async (files) => reply({ type: 'files', ...(await files.list()) }));
      case 'file.read':
        return this.withService('files', async (files) => reply({ type: 'file', path: command.path, content: await files.read(command.path) }));
      case 'skills.list':
        return this.withService('skills', async (skills) => reply({ type: 'skills', skills: await skills.list() }));
      case 'skill.save':
        return this.withService('skills', async (skills) => void (await skills.save(command.skill)));
      case 'skill.delete':
        return this.withService('skills', (skills) => skills.delete(command.id));
    }
  }

  /** Runs a file or skill request; their own errors are worded for people, anything else is logged. */
  private async withService<K extends 'files' | 'skills'>(
    name: K,
    action: (service: NonNullable<HubServices[K]>) => Promise<void>,
  ): Promise<CommandOutcome> {
    const service = this.services[name];
    if (!service) return { ok: false, error: `The ${name === 'files' ? 'file cabinet' : 'skill shelf'} is not available in this mode.` };
    try {
      await action(service);
      return { ok: true };
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof SkillError) return { ok: false, error: error.message };
      this.log.error(`[hub] ${name} request failed`, error);
      return { ok: false, error: `Could not ${name === 'files' ? 'read the workspace' : 'update the skills'}. See the server log.` };
    }
  }

  private async withSettings(action: (settings: SettingsService) => Promise<void>): Promise<CommandOutcome> {
    if (!this.settings) return { ok: false, error: 'Settings are not available in this mode.' };
    try {
      await action(this.settings);
      return { ok: true };
    } catch (error) {
      if (error instanceof SettingsError) return { ok: false, error: error.message };
      this.log.error('[hub] settings change failed', error);
      return { ok: false, error: 'Could not save settings. See the server log.' };
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const send of this.clients) send(message);
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
