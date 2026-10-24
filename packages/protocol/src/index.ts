/**
 * The contract between agent backends (mock, harness server, Claude Code hooks) and the
 * office. Everything crossing that boundary is validated with these schemas.
 */
import { z } from 'zod';

export const MAX_TEXT = 10_000;

const id = z.string().min(1).max(128);
const text = z.string().max(MAX_TEXT);

export const AgentRoleSchema = z.enum(['boss', 'architect', 'worker', 'reviewer', 'researcher']);
export const AgentStatusSchema = z.enum(['idle', 'thinking', 'working', 'blocked', 'done', 'error']);
export const TaskStateSchema = z.enum(['todo', 'doing', 'review', 'done', 'failed']);
export const HumanInputKindSchema = z.enum(['question', 'approval', 'choice']);

export const RunStatusSchema = z.enum(['done', 'stopped', 'failed']);

export const HarnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), goal: text }),
  z.object({ type: z.literal('run.finished'), status: RunStatusSchema, summary: text }),
  z.object({
    type: z.literal('agent.spawned'),
    agentId: id,
    role: AgentRoleSchema,
    name: z.string().min(1).max(64),
    model: z.string().max(128),
    /** Which configured provider runs this agent (e.g. "claude", "ollama"). */
    provider: z.string().max(64).optional(),
  }),
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

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;
const MAX_REPLAY_EVENTS = 20_000;

/** Server → browser, over the WebSocket. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocolVersion: z.number().int(), runId: id.nullable() }),
  /** Everything that happened in the current run so far, sent once right after `hello`. */
  z.object({ type: z.literal('replay'), envelopes: z.array(EnvelopeSchema).max(MAX_REPLAY_EVENTS) }),
  z.object({ type: z.literal('event'), envelope: EnvelopeSchema }),
  z.object({ type: z.literal('ack'), commandId: id, ok: z.boolean(), error: z.string().max(500).optional() }),
]);

/** Browser → server. `commandId` lets the server acknowledge (or reject) each command. */
export const ClientMessageSchema = z.object({
  type: z.literal('command'),
  commandId: id,
  command: HarnessCommandSchema,
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type HumanInputKind = z.infer<typeof HumanInputKindSchema>;
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];
export type EventOfType<K extends HarnessEventType> = Extract<HarnessEvent, { type: K }>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type HarnessCommand = z.infer<typeof HarnessCommandSchema>;

/**
 * A source of events: the in-browser mock, or a WebSocket to the harness server.
 * Listeners receive raw, unvalidated data — parse it with `EnvelopeSchema` at the boundary.
 */
export interface EventFeed {
  /** True when the events are invented (the mock), so the HUD never shows fake costs as real. */
  readonly isSimulated: boolean;
  subscribe(listener: (raw: unknown) => void): () => void;
  /** False when the command could not be sent (e.g. disconnected). */
  send(command: HarnessCommand): boolean;
}
