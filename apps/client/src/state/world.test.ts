import type { Envelope, HarnessEvent } from '@harness/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_WORLD, reduceWorld, type WorldState } from './world';

let seq = 0;
function envelope(event: HarnessEvent, runId = 'run-a'): Envelope {
  seq += 1;
  return { id: `${runId}-${seq}`, runId, ts: seq, seq, event };
}

function play(events: HarnessEvent[], start: WorldState = EMPTY_WORLD): WorldState {
  return events.reduce((state, event) => reduceWorld(state, envelope(event)), start);
}

const spawnBoss: HarnessEvent = { type: 'agent.spawned', agentId: 'boss', role: 'boss', name: 'BOSS', model: 'opus' };

describe('reduceWorld', () => {
  it('tracks an agent through status and tool changes', () => {
    const state = play([
      spawnBoss,
      { type: 'agent.status', agentId: 'boss', status: 'thinking' },
      { type: 'tool.started', agentId: 'boss', toolCallId: 'c1', tool: 'Read', summary: 'README.md' },
    ]);
    const boss = state.agents.get('boss');
    expect(boss?.status).toBe('thinking');
    expect(boss?.currentTool).toBe('Read');
  });

  it('clears the current tool when it finishes', () => {
    const state = play([
      spawnBoss,
      { type: 'tool.started', agentId: 'boss', toolCallId: 'c1', tool: 'Bash', summary: 'npm test' },
      { type: 'tool.finished', agentId: 'boss', toolCallId: 'c1', ok: true },
    ]);
    expect(state.agents.get('boss')?.currentTool).toBeNull();
  });

  it('follows a task from creation to done and links it to its agent', () => {
    const state = play([
      spawnBoss,
      { type: 'task.created', taskId: 't1', title: 'Build API' },
      { type: 'task.assigned', taskId: 't1', agentId: 'boss' },
      { type: 'task.updated', taskId: 't1', state: 'done' },
    ]);
    expect(state.tasks.get('t1')).toMatchObject({ state: 'done', agentId: 'boss' });
    expect(state.agents.get('boss')?.taskId).toBe('t1');
  });

  it('adds inbox requests and removes them once answered', () => {
    const asked = play([
      spawnBoss,
      { type: 'human.input_requested', requestId: 'r1', agentId: 'boss', prompt: 'SQLite?', options: ['Yes', 'No'], kind: 'choice' },
    ]);
    expect(asked.inbox.get('r1')?.options).toEqual(['Yes', 'No']);
    const answered = play([{ type: 'human.input_resolved', requestId: 'r1', answer: 'Yes' }], asked);
    expect(answered.inbox.size).toBe(0);
  });

  it('sums usage per agent and for the whole run', () => {
    const state = play([
      spawnBoss,
      { type: 'usage', agentId: 'boss', inputTokens: 100, outputTokens: 20, costUsd: 0.25 },
      { type: 'usage', agentId: 'boss', inputTokens: 50, outputTokens: 10, costUsd: 0.5 },
    ]);
    expect(state.totalCostUsd).toBeCloseTo(0.75);
    expect(state.agents.get('boss')?.tokens).toBe(180);
  });

  it('ignores duplicate or stale envelopes', () => {
    const first = envelope(spawnBoss);
    const once = reduceWorld(EMPTY_WORLD, first);
    expect(reduceWorld(once, first)).toBe(once);
  });

  it('keeps only the most recent 50 messages', () => {
    const messages: HarnessEvent[] = Array.from({ length: 60 }, (_, i) => ({ type: 'message.sent', from: 'a', to: 'b', text: `m${i}` }));
    const state = play(messages);
    expect(state.messages).toHaveLength(50);
    expect(state.messages.at(-1)?.text).toBe('m59');
  });

  it('keeps a short per-agent tool history with each call marked ok or failed', () => {
    const state = play([
      spawnBoss,
      { type: 'tool.started', agentId: 'boss', toolCallId: 'c1', tool: 'Bash', summary: 'npm test' },
      { type: 'tool.finished', agentId: 'boss', toolCallId: 'c1', ok: false },
      { type: 'tool.started', agentId: 'boss', toolCallId: 'c2', tool: 'Read', summary: 'README.md' },
    ]);
    expect(state.agents.get('boss')?.recentTools.map((call) => [call.tool, call.state])).toEqual([
      ['Read', 'running'],
      ['Bash', 'failed'],
    ]);
  });

  it('caps the tool history at 8 calls, newest first', () => {
    const calls: HarnessEvent[] = Array.from({ length: 12 }, (_, i) => ({
      type: 'tool.started', agentId: 'boss', toolCallId: `c${i}`, tool: 'Read', summary: `file${i}`,
    }));
    const tools = play([spawnBoss, ...calls]).agents.get('boss')?.recentTools ?? [];
    expect(tools).toHaveLength(8);
    expect(tools[0].summary).toBe('file11');
  });

  it('records logs and the latest plan', () => {
    const state = play([
      spawnBoss,
      { type: 'log', agentId: 'boss', level: 'error', text: 'tests failed' },
      { type: 'plan.updated', agentId: 'boss', markdown: 'API → UI' },
    ]);
    expect(state.logs.at(-1)).toMatchObject({ agentId: 'boss', level: 'error', text: 'tests failed' });
    expect(state.plan).toMatchObject({ agentId: 'boss', markdown: 'API → UI' });
  });

  it('stamps inbox requests with the time they were asked', () => {
    const state = play([
      spawnBoss,
      { type: 'human.input_requested', requestId: 'r1', agentId: 'boss', prompt: 'Go?', kind: 'question' },
    ]);
    expect(state.inbox.get('r1')?.requestedAt).toBeGreaterThan(0);
  });

  it('tracks the run goal from start to finish', () => {
    const running = play([{ type: 'run.started', goal: 'Build a todo app' }]);
    expect(running.run).toEqual({ goal: 'Build a todo app', status: 'running', summary: '' });
    const done = play([{ type: 'run.finished', status: 'done', summary: 'Shipped' }], running);
    expect(done.run).toEqual({ goal: 'Build a todo app', status: 'done', summary: 'Shipped' });
  });

  it('remembers which provider runs each agent', () => {
    const state = play([{ type: 'agent.spawned', agentId: 'w1', role: 'worker', name: 'W1', model: 'qwen', provider: 'ollama' }]);
    expect(state.agents.get('w1')?.provider).toBe('ollama');
  });

  it('starts fresh when a new run begins', () => {
    const state = play([spawnBoss]);
    const next = reduceWorld(state, envelope({ type: 'task.created', taskId: 't9', title: 'New run' }, 'run-b'));
    expect(next.runId).toBe('run-b');
    expect(next.agents.size).toBe(0);
    expect(next.tasks.size).toBe(1);
  });
});
