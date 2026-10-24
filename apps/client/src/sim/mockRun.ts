import type { Envelope, EventFeed, HarnessCommand, HarnessEvent, HumanInputKind } from '@harness/protocol';

/**
 * A scripted, endless fake run ("build a todo app") that emits the same events a
 * real backend will. Lets the office and HUD be built and demoed with no agents.
 * Pacing is deliberately bursty (fast read streaks, slow test runs) to exercise
 * the choreographer's merging and catch-up logic.
 */

type Range = readonly [min: number, max: number];

interface Question {
  prompt: string;
  options: readonly string[];
  kind: HumanInputKind;
}

const WORKER_COUNT = 6;
const DISPATCH_INTERVAL_SECONDS = 1.5;
const AUTO_ANSWER_SECONDS: Range = [10, 14];
const READ_BURST_SECONDS = 0.35;
const NEW_SPRINT_SIZE = 4;

const TASK_POOL = [
  'Set up REST API skeleton', 'Design todo data model', 'Add SQLite storage layer', 'Build todo list UI',
  'Add create/edit form', 'Write API integration tests', 'Add input validation', 'Wire up CI pipeline',
  'Add due-date reminders', 'Add drag-and-drop sorting', 'Write README and docs', 'Add session auth',
  'Optimize list rendering', 'Add dark mode',
];
const FILES = [
  'src/server.ts', 'src/routes/todos.ts', 'src/db/schema.ts', 'src/ui/TodoList.tsx', 'src/ui/TodoForm.tsx',
  'tests/todos.test.ts', 'package.json', 'README.md', 'src/validation.ts',
];
const SEARCHES = ['express zod validation', 'better-sqlite3 migrations', 'react list virtualization', 'vitest supertest example'];
const QUESTIONS: readonly Question[] = [
  { prompt: 'SQLite or Postgres for storage?', options: ['SQLite', 'Postgres'], kind: 'choice' },
  { prompt: 'OK to delete the old /legacy folder?', options: ['Approve', 'Deny'], kind: 'approval' },
  { prompt: 'Should todos support sub-tasks?', options: ['Yes', 'Not yet'], kind: 'question' },
];

const randomIn = ([min, max]: Range) => min + Math.random() * (max - min);
const chance = (probability: number) => Math.random() < probability;
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const pickSome = <T>(items: readonly T[], count: number): T[] =>
  [...items].sort(() => Math.random() - 0.5).slice(0, count);

export class MockRun implements EventFeed {
  private readonly listeners = new Set<(raw: unknown) => void>();
  private readonly runId = `mock-${Date.now().toString(36)}`;
  private readonly pendingAnswers = new Map<string, (answer: string) => void>();
  private readonly pendingTasks: Array<{ id: string; title: string }> = [];
  private readonly busyWorkers = new Set<string>();
  private readonly workers: string[] = [];
  private seq = 0;
  private counter = 0;
  private isRunning = false;
  private hasOpenQuestion = false;

  subscribe(listener: (raw: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: HarnessCommand): void {
    if (command.type === 'human.respond') this.pendingAnswers.get(command.requestId)?.(command.answer);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.script().catch((error: unknown) => console.error('[mock] run crashed', error));
  }

  stop(): void {
    this.isRunning = false;
  }

  private emit(event: HarnessEvent): void {
    this.seq += 1;
    const envelope: Envelope = { id: `${this.runId}-${this.seq}`, runId: this.runId, ts: Date.now(), seq: this.seq, event };
    for (const listener of this.listeners) listener(envelope);
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private say(from: string, to: string, text: string): void {
    this.emit({ type: 'message.sent', from, to, text });
  }

  private status(agentId: string, status: Extract<HarnessEvent, { type: 'agent.status' }>['status']): void {
    this.emit({ type: 'agent.status', agentId, status });
  }

  private async tool(agentId: string, tool: string, summary: string, seconds: number, ok = true): Promise<void> {
    const toolCallId = this.nextId('call');
    this.emit({ type: 'tool.started', agentId, toolCallId, tool, summary });
    await this.sleep(seconds);
    this.emit({ type: 'tool.finished', agentId, toolCallId, ok, summary: ok ? undefined : `${tool} failed` });
    const inputTokens = Math.round(randomIn([800, 4000]));
    const outputTokens = Math.round(randomIn([50, 600]));
    this.emit({ type: 'usage', agentId, inputTokens, outputTokens, costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000 });
  }

  private createTask(): void {
    const id = this.nextId('task');
    const title = pick(TASK_POOL);
    this.emit({ type: 'task.created', taskId: id, title });
    this.pendingTasks.push({ id, title });
  }

  private async script(): Promise<void> {
    this.emit({ type: 'agent.spawned', agentId: 'boss', role: 'boss', name: 'BOSS', model: 'claude-opus-5-5' });
    await this.sleep(1.2);
    this.emit({ type: 'agent.spawned', agentId: 'architect', role: 'architect', name: 'ARCHITECT', model: 'claude-opus-5-5' });
    await this.sleep(6);

    // Kickoff: the Boss briefs the Architect, who researches and draws the plan.
    this.status('boss', 'thinking');
    await this.sleep(2.5);
    this.say('boss', 'architect', 'Design a todo app: REST API, web UI, tests.');
    await this.sleep(4);
    this.status('architect', 'thinking');
    for (const file of ['package.json', 'README.md', 'docs/requirements.md']) {
      await this.tool('architect', 'Read', file, READ_BURST_SECONDS);
    }
    await this.tool('architect', 'WebSearch', 'todo app architecture', 3);
    this.emit({ type: 'plan.updated', agentId: 'architect', markdown: 'API → storage → UI → tests' });
    this.say('architect', 'boss', 'Plan ready: API, storage, UI, tests.');
    this.status('architect', 'idle');
    this.status('boss', 'working');

    for (let i = 0; i < 6; i++) this.createTask();
    for (let i = 1; i <= WORKER_COUNT; i++) {
      const agentId = `worker-${i}`;
      this.workers.push(agentId);
      this.emit({ type: 'agent.spawned', agentId, role: 'worker', name: `WORKER ${i}`, model: i % 3 === 0 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5' });
      await this.sleep(1.3);
    }
    await this.sleep(5);

    while (this.isRunning) {
      await this.dispatch();
      await this.sleep(DISPATCH_INTERVAL_SECONDS);
    }
  }

  /** The Boss hands pending tasks to idle workers, and plans a new sprint when everything is done. */
  private async dispatch(): Promise<void> {
    const idle = this.workers.find((worker) => !this.busyWorkers.has(worker));
    const task = idle ? this.pendingTasks.shift() : undefined;
    if (idle && task) {
      this.busyWorkers.add(idle);
      this.emit({ type: 'task.assigned', taskId: task.id, agentId: idle });
      this.say('boss', idle, `Please take: ${task.title}`);
      void this.work(idle, task);
      return;
    }
    if (!this.pendingTasks.length && this.busyWorkers.size === 0) {
      this.status('boss', 'thinking');
      await this.tool('boss', 'TodoWrite', 'Plan next sprint', 3);
      for (let i = 0; i < NEW_SPRINT_SIZE; i++) this.createTask();
      this.status('boss', 'working');
    }
  }

  private async work(agentId: string, task: { id: string; title: string }): Promise<void> {
    try {
      this.emit({ type: 'task.updated', taskId: task.id, state: 'doing' });
      this.status(agentId, 'working');
      const readTool = pick(['Read', 'Grep', 'Glob']);
      for (const file of pickSome(FILES, Math.round(randomIn([2, 5])))) {
        await this.tool(agentId, readTool, file, READ_BURST_SECONDS);
      }
      this.status(agentId, 'thinking');
      await this.sleep(randomIn([1.5, 3.5]));
      this.status(agentId, 'working');
      if (chance(0.35)) await this.tool(agentId, 'WebSearch', pick(SEARCHES), 3);
      for (let i = 0; i < Math.round(randomIn([1, 3])); i++) {
        await this.tool(agentId, pick(['Write', 'Edit']), pick(FILES), randomIn([1.5, 3]));
      }
      await this.runTests(agentId);
      if (chance(0.3) && !this.hasOpenQuestion) await this.askHuman(agentId);
      if (chance(0.25)) {
        this.say(agentId, 'architect', 'Quick question on the API shape?');
        await this.sleep(4);
        this.say('architect', agentId, 'Use REST + zod schemas.');
      }
      this.emit({ type: 'task.updated', taskId: task.id, state: 'done' });
      this.say(agentId, 'boss', `Done: ${task.title}`);
      if (chance(0.4)) {
        this.status(agentId, 'done');
        await this.sleep(randomIn([12, 18]));
      }
      this.status(agentId, 'idle');
    } finally {
      this.busyWorkers.delete(agentId);
    }
  }

  private async runTests(agentId: string): Promise<void> {
    const passed = chance(0.7);
    await this.tool(agentId, 'Bash', 'npm test', 3, passed);
    if (passed) return;
    this.emit({ type: 'log', agentId, level: 'error', text: '2 tests failed in tests/todos.test.ts' });
    this.status(agentId, 'error');
    await this.sleep(2);
    this.status(agentId, 'working');
    await this.tool(agentId, 'Edit', 'tests/todos.test.ts', 2);
    await this.tool(agentId, 'Bash', 'npm test', 3, true);
  }

  /** Walks the question to your desk; auto-answers with the first option until the inbox UI exists. */
  private async askHuman(agentId: string): Promise<void> {
    this.hasOpenQuestion = true;
    const question = pick(QUESTIONS);
    const requestId = this.nextId('ask');
    this.status(agentId, 'blocked');
    this.emit({ type: 'human.input_requested', requestId, agentId, prompt: question.prompt, options: [...question.options], kind: question.kind });
    const answered = new Promise<string>((resolve) => this.pendingAnswers.set(requestId, resolve));
    const timedOut = this.sleep(randomIn(AUTO_ANSWER_SECONDS)).then(() => question.options[0]);
    const answer = await Promise.race([answered, timedOut]);
    this.pendingAnswers.delete(requestId);
    this.emit({ type: 'human.input_resolved', requestId, answer });
    this.status(agentId, 'working');
    this.hasOpenQuestion = false;
  }
}
