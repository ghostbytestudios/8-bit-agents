import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, HarnessCommandSchema, HarnessEventSchema } from './index';

describe('HarnessEventSchema', () => {
  it('accepts a well-formed tool.started event', () => {
    const result = HarnessEventSchema.safeParse({
      type: 'tool.started', agentId: 'worker-1', toolCallId: 'call-1', tool: 'Read', summary: 'src/app.ts',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown event types', () => {
    expect(HarnessEventSchema.safeParse({ type: 'agent.exploded', agentId: 'x' }).success).toBe(false);
  });

  it('rejects an empty agent id', () => {
    expect(HarnessEventSchema.safeParse({ type: 'agent.status', agentId: '', status: 'idle' }).success).toBe(false);
  });

  it('rejects negative cost in usage events', () => {
    const result = HarnessEventSchema.safeParse({
      type: 'usage', agentId: 'boss', inputTokens: 10, outputTokens: 5, costUsd: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('EnvelopeSchema', () => {
  it('accepts an envelope wrapping a valid event', () => {
    const result = EnvelopeSchema.safeParse({
      id: 'run-1', runId: 'run', ts: 1, seq: 1,
      event: { type: 'agent.spawned', agentId: 'boss', role: 'boss', name: 'BOSS', model: 'claude-opus-5-5' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope whose event is invalid', () => {
    const result = EnvelopeSchema.safeParse({ id: 'run-1', runId: 'run', ts: 1, seq: 1, event: { type: 'nope' } });
    expect(result.success).toBe(false);
  });
});

describe('HarnessCommandSchema', () => {
  it('accepts pause/resume/stop for an agent', () => {
    for (const type of ['agent.pause', 'agent.resume', 'agent.stop']) {
      expect(HarnessCommandSchema.safeParse({ type, agentId: 'worker-2' }).success).toBe(true);
    }
  });

  it('rejects a run.start without a goal', () => {
    expect(HarnessCommandSchema.safeParse({ type: 'run.start', goal: '' }).success).toBe(false);
  });
});
