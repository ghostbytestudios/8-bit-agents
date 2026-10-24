import type { AgentRole, AgentStatus, Envelope, HumanInputKind, TaskState } from '@harness/protocol';

/**
 * The exact state of the run, rebuilt from events. The HUD reads this; the office
 * animation is a paced summary of the same events and may lag behind it.
 */
export interface AgentInfo {
  id: string;
  role: AgentRole;
  name: string;
  model: string;
  status: AgentStatus;
  currentTool: string | null;
  taskId: string | null;
  costUsd: number;
  tokens: number;
}

export interface TaskInfo {
  id: string;
  title: string;
  state: TaskState;
  agentId: string | null;
}

export interface InboxRequest {
  requestId: string;
  agentId: string;
  prompt: string;
  options: readonly string[];
  kind: HumanInputKind;
}

export interface ChatLine {
  from: string;
  to: string;
  text: string;
  ts: number;
}

export interface WorldState {
  runId: string | null;
  lastSeq: number;
  agents: ReadonlyMap<string, AgentInfo>;
  tasks: ReadonlyMap<string, TaskInfo>;
  inbox: ReadonlyMap<string, InboxRequest>;
  messages: readonly ChatLine[];
  totalCostUsd: number;
}

const MAX_MESSAGES = 50;

export const EMPTY_WORLD: WorldState = {
  runId: null,
  lastSeq: 0,
  agents: new Map(),
  tasks: new Map(),
  inbox: new Map(),
  messages: [],
  totalCostUsd: 0,
};

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map(map).set(key, value);
}

function withoutEntry<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function updateAgent(state: WorldState, agentId: string, patch: Partial<AgentInfo>): WorldState {
  const agent = state.agents.get(agentId);
  if (!agent) return state;
  return { ...state, agents: withEntry(state.agents, agentId, { ...agent, ...patch }) };
}

function updateTask(state: WorldState, taskId: string, patch: Partial<TaskInfo>): WorldState {
  const task = state.tasks.get(taskId);
  if (!task) return state;
  return { ...state, tasks: withEntry(state.tasks, taskId, { ...task, ...patch }) };
}

/** Pure reducer: returns a new state; duplicates and stale events (seq ≤ lastSeq) are ignored. */
export function reduceWorld(state: WorldState, envelope: Envelope): WorldState {
  const isNewRun = envelope.runId !== state.runId;
  const base = isNewRun ? { ...EMPTY_WORLD, runId: envelope.runId } : state;
  if (!isNewRun && envelope.seq <= state.lastSeq) return state;
  const next: WorldState = { ...base, lastSeq: envelope.seq };
  const event = envelope.event;

  switch (event.type) {
    case 'agent.spawned':
      return {
        ...next,
        agents: withEntry(next.agents, event.agentId, {
          id: event.agentId, role: event.role, name: event.name, model: event.model,
          status: 'idle', currentTool: null, taskId: null, costUsd: 0, tokens: 0,
        }),
      };
    case 'agent.status':
      return updateAgent(next, event.agentId, { status: event.status });
    case 'tool.started':
      return updateAgent(next, event.agentId, { currentTool: event.tool });
    case 'tool.finished':
      return updateAgent(next, event.agentId, { currentTool: null });
    case 'message.sent': {
      const line: ChatLine = { from: event.from, to: event.to, text: event.text, ts: envelope.ts };
      return { ...next, messages: [...next.messages, line].slice(-MAX_MESSAGES) };
    }
    case 'task.created':
      return {
        ...next,
        tasks: withEntry(next.tasks, event.taskId, { id: event.taskId, title: event.title, state: 'todo', agentId: null }),
      };
    case 'task.assigned':
      return updateAgent(updateTask(next, event.taskId, { agentId: event.agentId }), event.agentId, { taskId: event.taskId });
    case 'task.updated':
      return updateTask(next, event.taskId, { state: event.state });
    case 'human.input_requested':
      return {
        ...next,
        inbox: withEntry(next.inbox, event.requestId, {
          requestId: event.requestId, agentId: event.agentId, prompt: event.prompt,
          options: event.options ?? [], kind: event.kind,
        }),
      };
    case 'human.input_resolved':
      return { ...next, inbox: withoutEntry(next.inbox, event.requestId) };
    case 'usage': {
      const agent = next.agents.get(event.agentId);
      const withTotal = { ...next, totalCostUsd: next.totalCostUsd + event.costUsd };
      if (!agent) return withTotal;
      return updateAgent(withTotal, event.agentId, {
        costUsd: agent.costUsd + event.costUsd,
        tokens: agent.tokens + event.inputTokens + event.outputTokens,
      });
    }
    case 'plan.updated':
    case 'log':
      return next;
  }
}

/** Holds the current WorldState and notifies subscribers after each event. */
export class WorldStore {
  private current: WorldState = EMPTY_WORLD;
  private readonly listeners = new Set<(state: WorldState) => void>();

  get state(): WorldState {
    return this.current;
  }

  apply(envelope: Envelope): void {
    const next = reduceWorld(this.current, envelope);
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  subscribe(listener: (state: WorldState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
