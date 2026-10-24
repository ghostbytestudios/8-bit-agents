/**
 * The contract between agent backends (mock, Claude Code hooks, Agent SDK) and the
 * office. Everything crossing that boundary is validated with these schemas.
 */
import { z } from 'zod';

const MAX_TEXT = 10_000;

const id = z.string().min(1).max(128);
const text = z.string().max(MAX_TEXT);

export const AgentRoleSchema = z.enum(['boss', 'architect', 'worker', 'reviewer', 'researcher']);
export const AgentStatusSchema = z.enum(['idle', 'thinking', 'working', 'blocked', 'done', 'error']);
export const TaskStateSchema = z.enum(['todo', 'doing', 'review', 'done', 'failed']);
export const HumanInputKindSchema = z.enum(['question', 'approval', 'choice']);

export const HarnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent.spawned'), agentId: id, role: AgentRoleSchema, name: z.string().min(1).max(64), model: z.string().max(128) }),
  z.object({ type: z.literal('agent.status'), agentId: id, status: AgentStatusSchema }),
  z.object({ type: z.literal('tool.started'), agentId: id, toolCallId: id, tool: z.string().min(1).max(128), summary: text }),
  z.object({ type: z.literal('tool.finished'), agentId: id, toolCallId: id, ok: z.boolean(), summary: text.optional() }),
  z.object({ type: z.literal('message.sent'), from: id, to: id, text }),
  z.object({ type: z.literal('task.created'), taskId: id, title: z.string().min(1).max(200), parentId: id.optional() }),
  z.object({ type: z.literal('task.assigned'), taskId: id, agentId: id }),
  z.object({ type: z.literal('task.updated'), taskId: id, state: TaskStateSchema }),
  z.object({ type: z.literal('plan.updated'), agentId: id, mermaid: text.optional(), markdown: text.optional() }),
  z.object({
    type: z.literal('human.input_requested'),
    requestId: id,
    agentId: id,
    prompt: text,
    options: z.array(z.string().max(200)).max(10).optional(),
    kind: HumanInputKindSchema,
  }),
  z.object({ type: z.literal('human.input_resolved'), requestId: id, answer: text }),
  z.object({
    type: z.literal('usage'),
    agentId: id,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('log'), agentId: id, level: z.enum(['info', 'warn', 'error']), text }),
]);

/** Every event travels in an envelope; `seq` only ever increases within a run. */
export const EnvelopeSchema = z.object({
  id,
  runId: id,
  ts: z.number().nonnegative(),
  seq: z.number().int().nonnegative(),
  event: HarnessEventSchema,
});

export const HarnessCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.start'), goal: z.string().min(1).max(MAX_TEXT) }),
  z.object({ type: z.literal('run.stop'), runId: id }),
  z.object({ type: z.literal('human.respond'), requestId: id, answer: text }),
  z.object({ type: z.literal('agent.message'), agentId: id, text }),
  z.object({ type: z.enum(['agent.pause', 'agent.resume', 'agent.stop']), agentId: id }),
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type HumanInputKind = z.infer<typeof HumanInputKindSchema>;
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];
export type EventOfType<K extends HarnessEventType> = Extract<HarnessEvent, { type: K }>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type HarnessCommand = z.infer<typeof HarnessCommandSchema>;

/**
 * A source of events: the in-browser mock today, a WebSocket to the server later.
 * Listeners receive raw, unvalidated data — parse it with `EnvelopeSchema` at the boundary.
 */
export interface EventFeed {
  subscribe(listener: (raw: unknown) => void): () => void;
  send(command: HarnessCommand): void;
}
