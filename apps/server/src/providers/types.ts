/**
 * The seam between the harness and any model. Agents only ever see these types, so a
 * role can run on Claude, a hosted API, or a model on your own machine.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; unvalidated — the agent loop checks them against the tool's schema. */
  input: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

/** One user turn: tool results for the previous assistant turn, a message, or both. */
export interface TurnInput {
  toolResults?: readonly ToolResult[];
  text?: string;
}

export type StopReason = 'done' | 'tool_use' | 'max_tokens' | 'refused';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AssistantTurn {
  text: string;
  toolCalls: readonly ToolCall[];
  stop: StopReason;
  usage: TurnUsage;
}

export interface ConversationOptions {
  model: string;
  system: string;
  tools: readonly ToolSpec[];
  effort?: Effort;
}

/**
 * A running conversation with one model. Each provider keeps the history in its own
 * wire format (append-only), so nothing provider-specific — like Claude's thinking
 * blocks — is lost by translating back and forth.
 */
export interface Conversation {
  send(input: TurnInput, signal?: AbortSignal): Promise<AssistantTurn>;
}

export interface ModelProvider {
  /** The name this provider has in harness.config.json. */
  readonly id: string;
  /** Runs on this machine (no per-token bill). */
  readonly isLocal: boolean;
  startConversation(options: ConversationOptions): Conversation;
}

/** A model call failed in a way the user should hear about (bad key, server down, refusal). */
export class ProviderError extends Error {
  constructor(message: string, readonly isRetryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}
