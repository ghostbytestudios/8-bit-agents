import { MAX_TEXT, type HarnessEvent } from '@harness/protocol';
import { z } from 'zod';
import type { Conversation, ToolCall, ToolResult, TurnInput, TurnUsage } from './providers/types';
import type { ToolContext, ToolDef } from './tools';

/**
 * Drives one agent through tool calls until it calls one of its "final" tools. Works the
 * same for every provider; everything it does becomes office events.
 */

/** Tool output beyond this is cut so one huge file can't flood the model's context. */
const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_SUMMARY_CHARS = 200;
const MAX_LOG_CHARS = 2_000;
/** Reminders sent when a model stops talking without calling a final tool. */
const MAX_NUDGES = 2;

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface AgentLoopOptions {
  agentId: string;
  conversation: Conversation;
  tools: readonly ToolDef[];
  /** Tool names that finish this job when they succeed (e.g. complete_task). */
  finalTools: readonly string[];
  context: ToolContext;
  maxTurns: number;
  emit(event: HarnessEvent): void;
  /** Called with each turn's usage; may throw to stop the run (budget). */
  onUsage(usage: TurnUsage): void;
  nextId(prefix: string): string;
}

export interface AgentLoopResult {
  finalTool: { name: string; input: unknown };
  /** Results for the last assistant turn; send them with the next message in this conversation. */
  pendingResults: ToolResult[];
}

interface CallOutcome {
  result: ToolResult;
  isFinal: boolean;
}

async function runToolCall(call: ToolCall, options: AgentLoopOptions): Promise<CallOutcome> {
  const { agentId, tools, finalTools, context, emit } = options;
  const definition = tools.find((candidate) => candidate.name === call.name);
  const reject = (content: string): CallOutcome => ({ result: { callId: call.id, content, isError: true }, isFinal: false });
  if (!definition) return reject(`Unknown tool "${call.name}". Available tools: ${tools.map((entry) => entry.name).join(', ')}.`);

  const parsed = definition.schema.safeParse(call.input);
  if (!parsed.success) return reject(`Invalid arguments for ${call.name}:\n${clip(z.prettifyError(parsed.error), MAX_LOG_CHARS)}\nFix them and call it again.`);

  const toolCallId = options.nextId('call');
  emit({ type: 'tool.started', agentId, toolCallId, tool: definition.name, summary: clip(definition.summarize(parsed.data), MAX_SUMMARY_CHARS) });
  try {
    const content = await definition.run(parsed.data, context);
    emit({ type: 'tool.finished', agentId, toolCallId, ok: true });
    return { result: { callId: call.id, content: clip(content, MAX_TOOL_RESULT_CHARS), isError: false }, isFinal: finalTools.includes(definition.name) };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'tool.finished', agentId, toolCallId, ok: false, summary: clip(message, MAX_SUMMARY_CHARS) });
    return reject(message);
  }
}

export async function runAgent(options: AgentLoopOptions, firstInput: TurnInput): Promise<AgentLoopResult> {
  const { agentId, conversation, finalTools, context, emit, maxTurns } = options;
  let input = firstInput;
  let nudges = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    context.signal.throwIfAborted();
    emit({ type: 'agent.status', agentId, status: 'thinking' });
    const reply = await conversation.send(input, context.signal);
    emit({ type: 'usage', agentId, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens, costUsd: reply.usage.costUsd });
    options.onUsage(reply.usage);
    if (reply.text.trim()) emit({ type: 'log', agentId, level: 'info', text: clip(reply.text.trim(), Math.min(MAX_LOG_CHARS, MAX_TEXT)) });
    if (reply.stop === 'refused') throw new AgentError('The model declined to continue.');

    if (!reply.toolCalls.length) {
      if (nudges >= MAX_NUDGES) throw new AgentError(`Stopped without calling ${finalTools.join(' or ')}.`);
      nudges += 1;
      input = { text: `Keep going using your tools. When you are finished, call ${finalTools.join(' or ')}.` };
      continue;
    }

    emit({ type: 'agent.status', agentId, status: 'working' });
    // Every call in a turn gets a result, even after a final tool, so the history stays valid.
    const results: ToolResult[] = [];
    let finalTool: AgentLoopResult['finalTool'] | null = null;
    for (const call of reply.toolCalls) {
      const outcome = await runToolCall(call, options);
      results.push(outcome.result);
      if (outcome.isFinal && !finalTool) finalTool = { name: call.name, input: call.input };
    }
    if (finalTool) return { finalTool, pendingResults: results };
    input = { toolResults: results };
  }
  throw new AgentError(`Used all ${maxTurns} turns without finishing.`);
}
