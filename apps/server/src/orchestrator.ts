import { randomUUID } from 'node:crypto';
import { MAX_TEXT, type AgentRole, type HarnessEvent, type HumanInputKind, type Skill, type TaskState } from '@harness/protocol';
import { clip, runAgent, type AgentLoopResult } from './agentLoop';
import type { RoleName, RunConfig } from './config';
import { ARCHITECT_PROMPT, BOSS_PROMPT, WORKER_PROMPT, architectBrief, bossBrief, roundReport, skillsSection, workerBrief } from './prompts';
import type { Conversation, ModelProvider, ToolResult, TurnInput, TurnUsage } from './providers/types';
import { ARCHITECT_TOOLS, BOSS_TOOLS, READ_SKILL_TOOL, WORKER_TOOLS, toolSpecs, type NewTask, type RunPort, type ToolDef } from './tools';
import type { Workspace } from './workspace';

/**
 * One run of the team: the Architect plans, the Boss turns the plan into tasks, Workers
 * build them in parallel, and the Boss decides when the goal is met. Dispatch is plain
 * code, not a model decision, which keeps weaker local models on rails.
 */

const BOSS_ID = 'boss';
const ARCHITECT_ID = 'architect';
const MESSAGE_CHARS = 500;

class BudgetError extends Error {}
class StoppedError extends Error {}

interface TaskRecord {
  id: string;
  title: string;
  details: string;
  state: TaskState;
  agentId: string | null;
  summary: string;
}

interface PendingQuestion {
  agentId: string;
  resolve(answer: string): void;
}

export interface RunDeps {
  config: RunConfig;
  providers: ReadonlyMap<string, ModelProvider>;
  workspace: Workspace;
  /** Enabled skills from the War Room shelf; each role sees only the ones given to it. */
  skills?: readonly Skill[];
  emit(event: HarnessEvent): void;
}

interface RoleSetup {
  prompt: string;
  tools: readonly ToolDef[];
}

const ROLE_SETUP: Record<RoleName, RoleSetup> = {
  boss: { prompt: BOSS_PROMPT, tools: BOSS_TOOLS },
  architect: { prompt: ARCHITECT_PROMPT, tools: ARCHITECT_TOOLS },
  worker: { prompt: WORKER_PROMPT, tools: WORKER_TOOLS },
};

export class Run implements RunPort {
  readonly workspace: Workspace;
  private readonly controller = new AbortController();
  private readonly workerIds: string[];
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly taskOfWorker = new Map<string, TaskRecord>();
  /** Open inbox questions; cleared (and resolved in the UI) by `finish`. */
  private readonly questions = new Map<string, PendingQuestion>();
  private architectChat: Conversation | null = null;
  private architectOwed: ToolResult[] = [];
  private architectQueue: Promise<unknown> = Promise.resolve();
  private architectAnswer: string | null = null;
  private goal = '';
  private plan = '';
  private summary = '';
  private costUsd = 0;
  private tokens = 0;
  private round = 0;
  private counter = 0;

  constructor(private readonly deps: RunDeps) {
    this.workspace = deps.workspace;
    this.workerIds = Array.from({ length: deps.config.workers }, (_, index) => `worker-${index + 1}`);
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  async start(goal: string): Promise<void> {
    this.goal = goal;
    this.emit({ type: 'run.started', goal: clip(goal, MAX_TEXT) });
    this.spawnTeam();
    try {
      await this.planPhase();
      await this.bossPhase();
      this.finish('done', this.summary || 'The Boss wrapped up without a summary.');
    } catch (error) {
      const reason: unknown = this.signal.aborted ? this.signal.reason : error;
      if (reason instanceof BudgetError) this.finish('failed', reason.message);
      else if (reason instanceof StoppedError) this.finish('stopped', 'Stopped by you.');
      else {
        const message = reason instanceof Error ? reason.message : String(reason);
        this.emit({ type: 'log', agentId: BOSS_ID, level: 'error', text: clip(message, MAX_TEXT) });
        this.finish('failed', message);
      }
    }
  }

  stop(): void {
    if (!this.signal.aborted) this.controller.abort(new StoppedError('Stopped by you.'));
  }

  /** Delivers an inbox answer; false when no such question is open. */
  respond(requestId: string, answer: string): boolean {
    const question = this.questions.get(requestId);
    if (!question || this.signal.aborted) return false;
    this.questions.delete(requestId);
    this.emit({ type: 'human.input_resolved', requestId, answer });
    this.emit({ type: 'agent.status', agentId: question.agentId, status: 'working' });
    question.resolve(answer);
    return true;
  }

  // ── Phases ─────────────────────────────────────────────────────────────────

  private spawnTeam(): void {
    const spawn = (agentId: string, role: AgentRole, roleName: RoleName, name: string) => {
      const { provider, model } = this.deps.config.roles[roleName];
      this.emit({ type: 'agent.spawned', agentId, role, name, model, provider });
    };
    spawn(BOSS_ID, 'boss', 'boss', this.nameOf(BOSS_ID));
    spawn(ARCHITECT_ID, 'architect', 'architect', this.nameOf(ARCHITECT_ID));
    this.workerIds.forEach((agentId) => spawn(agentId, 'worker', 'worker', this.nameOf(agentId)));
  }

  /** The name you gave this agent in Settings, or its default. */
  private nameOf(agentId: string): string {
    const names = this.deps.config.names;
    if (agentId === BOSS_ID) return names?.boss ?? 'BOSS';
    if (agentId === ARCHITECT_ID) return names?.architect ?? 'ARCHITECT';
    const index = this.workerIds.indexOf(agentId);
    return names?.workers[index] ?? `WORKER ${index + 1}`;
  }

  private async planPhase(): Promise<void> {
    this.architectChat = this.startChat('architect');
    const result = await this.loop(ARCHITECT_ID, this.architectChat, 'architect', ['write_plan'], { text: architectBrief(this.goal) });
    this.architectOwed = result.pendingResults;
    this.emit({ type: 'agent.status', agentId: ARCHITECT_ID, status: 'idle' });
  }

  private async bossPhase(): Promise<void> {
    const chat = this.startChat('boss');
    let input: TurnInput = { text: bossBrief(this.goal, this.plan) };
    for (;;) {
      const result = await this.loop(BOSS_ID, chat, 'boss', ['create_tasks', 'finish_run'], input);
      if (result.finalTool.name === 'finish_run') return;
      this.emit({ type: 'agent.status', agentId: BOSS_ID, status: 'idle' });
      const batch = [...this.tasks.values()].filter((task) => task.state === 'todo');
      await this.workOn(batch);
      const report = batch.map((task) => `- [${task.state}] ${task.title}: ${task.summary}`);
      input = { toolResults: result.pendingResults, text: roundReport(report, this.round, this.deps.config.limits.maxRounds) };
    }
  }

  /** Each worker takes the next waiting task until the batch is empty. */
  private async workOn(batch: readonly TaskRecord[]): Promise<void> {
    const queue = [...batch];
    await Promise.all(this.workerIds.map(async (workerId) => {
      for (let task = queue.shift(); task; task = queue.shift()) await this.runTask(workerId, task);
    }));
  }

  private async runTask(workerId: string, task: TaskRecord): Promise<void> {
    this.signal.throwIfAborted();
    task.state = 'doing';
    task.agentId = workerId;
    this.taskOfWorker.set(workerId, task);
    this.emit({ type: 'task.assigned', taskId: task.id, agentId: workerId });
    this.emit({ type: 'message.sent', from: BOSS_ID, to: workerId, text: clip(`Please take: ${task.title}`, MESSAGE_CHARS) });
    this.emit({ type: 'task.updated', taskId: task.id, state: 'doing' });
    try {
      // A fresh conversation per task keeps each worker's context small.
      await this.loop(workerId, this.startChat('worker'), 'worker', ['complete_task'], {
        text: workerBrief(this.goal, this.plan, task.title, task.details),
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      task.state = 'failed';
      task.summary = message;
      this.emit({ type: 'log', agentId: workerId, level: 'error', text: clip(message, MAX_TEXT) });
    } finally {
      this.taskOfWorker.delete(workerId);
    }
    // complete_task updated the record through RunPort, which TypeScript's narrowing can't see.
    const finalState: TaskState = task.state as TaskState;
    const isDone = finalState === 'done';
    this.emit({ type: 'task.updated', taskId: task.id, state: finalState });
    this.emit({ type: 'message.sent', from: workerId, to: BOSS_ID, text: clip(`${isDone ? 'Done' : "Couldn't finish"}: ${task.title}`, MESSAGE_CHARS) });
    this.emit({ type: 'agent.status', agentId: workerId, status: isDone ? 'done' : 'error' });
  }

  // ── RunPort (what tools can ask of the run) ────────────────────────────────

  createTasks(_agentId: string, newTasks: readonly NewTask[]): string {
    const { maxRounds, maxTasks } = this.deps.config.limits;
    if (this.round >= maxRounds) throw new Error(`No task rounds left (limit ${maxRounds}). Call finish_run with a summary.`);
    if (this.tasks.size + newTasks.length > maxTasks) {
      throw new Error(`That would pass this run's limit of ${maxTasks} tasks (${this.tasks.size} so far). Create fewer or call finish_run.`);
    }
    this.round += 1;
    for (const { title, details } of newTasks) {
      const task: TaskRecord = { id: this.nextId('task'), title, details, state: 'todo', agentId: null, summary: '' };
      this.tasks.set(task.id, task);
      this.emit({ type: 'task.created', taskId: task.id, title });
    }
    return `Created ${newTasks.length} task(s). The workers start now; you will get their reports when they finish.`;
  }

  writePlan(agentId: string, markdown: string): void {
    this.plan = markdown;
    this.emit({ type: 'plan.updated', agentId, markdown: clip(markdown, MAX_TEXT) });
  }

  completeTask(agentId: string, summary: string, isSuccess: boolean): void {
    const task = this.taskOfWorker.get(agentId);
    if (!task) throw new Error('You have no task to complete.');
    task.state = isSuccess ? 'done' : 'failed';
    task.summary = summary;
  }

  finishRun(_agentId: string, summary: string): void {
    this.summary = summary;
  }

  answerQuestion(_agentId: string, answer: string): void {
    this.architectAnswer = answer;
  }

  readSkill(agentId: string, name: string): string {
    const skills = this.skillsFor(this.roleOf(agentId));
    const wanted = name.trim().toLowerCase();
    const skill = skills.find((candidate) => candidate.name.toLowerCase() === wanted || candidate.id === wanted);
    if (!skill) {
      const names = skills.map((candidate) => `"${candidate.name}"`).join(', ');
      throw new Error(`You have no skill called "${name}". Your skills: ${names || 'none'}.`);
    }
    return `# ${skill.name}\n\n${skill.body || '(This skill is empty.)'}`;
  }

  async askHuman(agentId: string, prompt: string, options: readonly string[], kind: HumanInputKind): Promise<string> {
    this.signal.throwIfAborted();
    // Random, not sequential: an answer meant for an old run's card can never match a new run's question.
    const requestId = `ask-${randomUUID()}`;
    this.emit({ type: 'agent.status', agentId, status: 'blocked' });
    this.emit({ type: 'human.input_requested', requestId, agentId, prompt: clip(prompt, MAX_TEXT), options: [...options], kind });
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.questions.set(requestId, {
        agentId,
        resolve: (answer) => {
          this.signal.removeEventListener('abort', onAbort);
          resolve(answer);
        },
      });
    });
  }

  /** Workers' questions are answered one at a time in the Architect's own conversation. */
  askArchitect(agentId: string, question: string): Promise<string> {
    this.emit({ type: 'message.sent', from: agentId, to: ARCHITECT_ID, text: clip(question, MESSAGE_CHARS) });
    const job = this.architectQueue.then(() => this.consultArchitect(agentId, question));
    this.architectQueue = job.catch(() => undefined);
    return job;
  }

  private async consultArchitect(agentId: string, question: string): Promise<string> {
    if (!this.architectChat) throw new Error('The Architect is not available.');
    this.architectAnswer = null;
    const result = await this.loop(ARCHITECT_ID, this.architectChat, 'architect', ['answer'], {
      toolResults: this.architectOwed,
      text: `${this.nameOf(agentId)} asks: ${question}\nReply with the answer tool.`,
    });
    this.architectOwed = result.pendingResults;
    const reply = this.architectAnswer ?? '(no answer)';
    this.emit({ type: 'message.sent', from: ARCHITECT_ID, to: agentId, text: clip(reply, MESSAGE_CHARS) });
    this.emit({ type: 'agent.status', agentId: ARCHITECT_ID, status: 'idle' });
    return `The Architect says: ${reply}`;
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private startChat(role: RoleName): Conversation {
    const { provider: providerId, model, effort } = this.deps.config.roles[role];
    const provider = this.deps.providers.get(providerId);
    if (!provider) throw new Error(`No provider "${providerId}" is configured for the ${role}.`);
    const { prompt, tools } = this.setupFor(role);
    return provider.startConversation({ model, system: prompt, tools: toolSpecs(tools), effort });
  }

  private roleOf(agentId: string): RoleName {
    if (agentId === BOSS_ID) return 'boss';
    if (agentId === ARCHITECT_ID) return 'architect';
    return 'worker';
  }

  private skillsFor(role: RoleName): readonly Skill[] {
    return (this.deps.skills ?? []).filter((skill) => skill.enabled && skill.roles.includes(role));
  }

  /** A role with skills gets them listed in its prompt, plus the tool to read them. */
  private setupFor(role: RoleName): RoleSetup {
    const base = ROLE_SETUP[role];
    const skills = this.skillsFor(role);
    if (!skills.length) return base;
    return { prompt: `${base.prompt}\n\n${skillsSection(skills)}`, tools: [...base.tools, READ_SKILL_TOOL] };
  }

  private loop(agentId: string, conversation: Conversation, role: RoleName, finalTools: readonly string[], input: TurnInput): Promise<AgentLoopResult> {
    return runAgent({
      agentId,
      conversation,
      tools: this.setupFor(role).tools,
      finalTools,
      context: { agentId, run: this, signal: this.signal },
      maxTurns: this.deps.config.limits.maxTurnsPerTask,
      emit: (event) => this.emit(event),
      onUsage: (usage) => this.addUsage(usage),
      nextId: (prefix) => this.nextId(prefix),
    }, input);
  }

  /**
   * Two independent caps: dollars (for priced models) and tokens (so models with no
   * known price — a new model id, a provider without `pricing` — still can't run forever).
   */
  private addUsage(usage: TurnUsage): void {
    const count = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
    this.costUsd += count(usage.costUsd);
    this.tokens += count(usage.inputTokens) + count(usage.outputTokens);
    const { maxRunCostUsd, maxRunTokens } = this.deps.config.limits;
    let reason: string | null = null;
    if (this.costUsd > maxRunCostUsd) reason = `spent $${this.costUsd.toFixed(2)}, over its $${maxRunCostUsd.toFixed(2)} budget (limits.maxRunCostUsd)`;
    else if (this.tokens > maxRunTokens) reason = `used ${this.tokens.toLocaleString('en-US')} tokens, over its budget of ${maxRunTokens.toLocaleString('en-US')} (limits.maxRunTokens)`;
    if (!reason) return;
    const error = new BudgetError(`Stopped: this run ${reason}.`);
    this.controller.abort(error);
    throw error;
  }

  private finish(status: 'done' | 'stopped' | 'failed', summary: string): void {
    if (!this.signal.aborted) this.controller.abort(new StoppedError('Run finished.'));
    // Clear any question still on your desk.
    for (const requestId of this.questions.keys()) this.emit({ type: 'human.input_resolved', requestId, answer: '(run ended)' });
    this.questions.clear();
    for (const agentId of [BOSS_ID, ARCHITECT_ID, ...this.workerIds]) this.emit({ type: 'agent.status', agentId, status: 'idle' });
    this.emit({ type: 'run.finished', status, summary: clip(summary, MAX_TEXT) });
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private emit(event: HarnessEvent): void {
    this.deps.emit(event);
  }
}
