import { z } from 'zod';
import {
  ProviderError,
  type AssistantTurn,
  type Conversation,
  type ConversationOptions,
  type ModelProvider,
  type StopReason,
  type ToolCall,
  type TurnInput,
} from './types';

/**
 * Any server that speaks the OpenAI `/chat/completions` dialect with function calling:
 * Ollama, LM Studio, llama.cpp server, vLLM, LocalAI, OpenRouter, Groq, Together, OpenAI…
 */

/** Local models can be slow to load and generate. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const ERROR_SNIPPET_CHARS = 300;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Responses come from arbitrary servers, so every field we read is validated.
const WireToolCallSchema = z.object({
  id: z.string().optional(),
  function: z.object({
    name: z.string(),
    // Most servers send a JSON string; some (older Ollama) send an object.
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  }),
});
const ResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(WireToolCallSchema).nullish(),
    }),
  })).min(1),
  // Negative or non-finite usage would let a server shrink the run's spend counter.
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).nullish(),
});

const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(128) })) });
const LIST_TIMEOUT_MS = 15_000;
const MAX_LISTED_MODELS = 200;

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type Fetch = typeof fetch;

/** Parses one wire tool call; arguments that aren't valid JSON are handed on as-is for the loop to reject. */
function toToolCall(wire: z.infer<typeof WireToolCallSchema>, fallbackId: string): { call: ToolCall; stored: WireToolCall } {
  const id = wire.id || fallbackId;
  const raw = wire.function.arguments ?? '{}';
  const argumentsText = typeof raw === 'string' ? raw : JSON.stringify(raw);
  let input: unknown;
  try {
    input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch {
    input = { invalidJson: argumentsText };
  }
  return {
    call: { id, name: wire.function.name, input },
    stored: { id, type: 'function', function: { name: wire.function.name, arguments: argumentsText } },
  };
}

function toStop(finishReason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refused';
  return 'done';
}

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  pricing?: Readonly<Record<string, ModelPrice>>;
  /** Test seam. */
  fetch?: Fetch;
}

class ChatConversation implements Conversation {
  private readonly messages: ChatMessage[];
  private callCounter = 0;

  constructor(private readonly provider: OpenAICompatibleProvider, private readonly options: ConversationOptions) {
    this.messages = [{ role: 'system', content: options.system }];
  }

  async send(input: TurnInput, signal?: AbortSignal): Promise<AssistantTurn> {
    const userTurn: ChatMessage[] = (input.toolResults ?? []).map((result) => ({
      role: 'tool',
      tool_call_id: result.callId,
      content: result.isError ? `ERROR: ${result.content}` : result.content,
    }));
    if (input.text) userTurn.push({ role: 'user', content: input.text });
    if (!userTurn.length) throw new Error('A turn needs text or tool results');

    const body = {
      model: this.options.model,
      messages: [...this.messages, ...userTurn],
      stream: false,
      ...(this.options.tools.length ? {
        tools: this.options.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
      } : {}),
    };
    const response = await this.provider.post(body, this.options.model, signal);
    const choice = response.choices[0];
    const parsed = (choice.message.tool_calls ?? []).map((wire) => toToolCall(wire, `call_${++this.callCounter}`));
    const text = choice.message.content ?? '';

    this.messages.push(...userTurn, {
      role: 'assistant',
      content: text || null,
      ...(parsed.length ? { tool_calls: parsed.map((entry) => entry.stored) } : {}),
    });
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    return {
      text,
      toolCalls: parsed.map((entry) => entry.call),
      stop: toStop(choice.finish_reason, parsed.length > 0),
      usage: { inputTokens, outputTokens, costUsd: this.provider.costUsd(this.options.model, inputTokens, outputTokens) },
    };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly isLocal: boolean;
  private readonly base: string;
  private readonly endpoint: string;
  private readonly fetch: Fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    const base = new URL(options.baseUrl);
    this.isLocal = LOOPBACK_HOSTS.has(base.hostname);
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = `${this.base}/chat/completions`;
    this.fetch = options.fetch ?? fetch;
  }

  startConversation(options: ConversationOptions): Conversation {
    return new ChatConversation(this, options);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch(`${this.base}/models`, {
        headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ProviderError(`Couldn't reach "${this.id}" at ${this.options.baseUrl}. Is the model server running?`, true);
    }
    if (!response.ok) throw await this.httpError(response, 'models');
    const parsed = ModelListSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ProviderError(`"${this.id}" answered, but not with an OpenAI-compatible model list.`);
    return parsed.data.data.map((model) => model.id).slice(0, MAX_LISTED_MODELS);
  }

  costUsd(model: string, inputTokens: number, outputTokens: number): number {
    const price = this.options.pricing?.[model];
    if (!price) return 0;
    return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  }

  async post(body: unknown, model: string, signal?: AbortSignal): Promise<z.infer<typeof ResponseSchema>> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ProviderError(`Couldn't reach "${this.id}" at ${this.options.baseUrl}. Is the model server running?`, true);
    }
    if (!response.ok) throw await this.httpError(response, model);

    const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ProviderError(`"${this.id}" sent a response that isn't OpenAI-compatible chat completions.`);
    return parsed.data;
  }

  private async httpError(response: Response, model: string): Promise<ProviderError> {
    const body = await response.text().catch(() => '');
    // A server that echoes request headers must not put the key in front of the user.
    const redacted = this.options.apiKey ? body.split(this.options.apiKey).join('[redacted]') : body;
    const snippet = redacted.slice(0, ERROR_SNIPPET_CHARS);
    if (response.status === 401 || response.status === 403) {
      return new ProviderError(`"${this.id}" rejected the API key (HTTP ${response.status}). Check the provider's apiKeyEnv.`);
    }
    if (response.status === 404) {
      return new ProviderError(`"${this.id}" has no model "${model}" (for Ollama: \`ollama pull ${model}\`). ${snippet}`.trim());
    }
    return new ProviderError(`"${this.id}" returned HTTP ${response.status}: ${snippet}`, response.status === 429 || response.status >= 500);
  }
}
