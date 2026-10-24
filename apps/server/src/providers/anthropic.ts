import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type AssistantTurn,
  type Conversation,
  type ConversationOptions,
  type ModelProvider,
  type StopReason,
  type TurnInput,
} from './types';

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateMessage = (params: MessageParams, options: { signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage>;

interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** First-party API prices, $ per million tokens. */
const CLAUDE_PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};
/** Haiku 5.5 bills prompts over 100K tokens at a higher rate. */
const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_LONG_PROMPT_PRICE: Price = { inputPerMTok: 0.5, outputPerMTok: 2.5 };
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Models that accept the server-side refusal fallback; a declined request is re-run on a fallback model. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Non-streaming requests stay under the SDK's HTTP timeout at this size. */
const MAX_OUTPUT_TOKENS = 16_000;

export function claudeCostUsd(model: string, usage: Anthropic.Beta.BetaUsage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
  const base = CLAUDE_PRICES[model];
  if (!base) return 0;
  const price = model === 'claude-haiku-5-5' && promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_LONG_PROMPT_PRICE : base;
  const input = usage.input_tokens + cacheRead * CACHE_READ_MULTIPLIER + cacheWrite * CACHE_WRITE_MULTIPLIER;
  return (input * price.inputPerMTok + usage.output_tokens * price.outputPerMTok) / 1_000_000;
}

function toUserContent(input: TurnInput): Anthropic.Beta.BetaContentBlockParam[] {
  // All results for one assistant turn go back in a single user message.
  const content: Anthropic.Beta.BetaContentBlockParam[] = (input.toolResults ?? []).map((result) => ({
    type: 'tool_result',
    tool_use_id: result.callId,
    content: result.content,
    is_error: result.isError,
  }));
  if (input.text) content.push({ type: 'text', text: input.text });
  if (!content.length) throw new Error('A turn needs text or tool results');
  return content;
}

function toStop(reason: Anthropic.Beta.BetaMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'refusal': return 'refused';
    default: return 'done';
  }
}

function toTurn(response: Anthropic.Beta.BetaMessage, requestedModel: string): AssistantTurn {
  const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
  const toolCalls = response.content.flatMap((block) =>
    block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
  // With a fallback, `response.model` names the model that actually answered.
  const pricedModel = CLAUDE_PRICES[response.model] ? response.model : requestedModel;
  const usage = response.usage;
  return {
    text,
    toolCalls,
    stop: toStop(response.stop_reason),
    usage: {
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      costUsd: claudeCostUsd(pricedModel, usage),
    },
  };
}

/** Typed SDK errors → messages a person can act on; aborts pass through untouched. */
function toProviderError(error: unknown, model: string): Error {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError('Claude rejected the credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart the server.');
  }
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError(`This Claude account can't use ${model}.`);
  if (error instanceof Anthropic.NotFoundError) return new ProviderError(`Claude doesn't know the model "${model}". Check harness.config.json.`);
  if (error instanceof Anthropic.RateLimitError) return new ProviderError('Claude rate limit reached; try again shortly.', true);
  if (error instanceof Anthropic.BadRequestError) return new ProviderError(`Claude rejected the request: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("Couldn't reach the Claude API.", true);
  if (error instanceof Anthropic.APIError) {
    return new ProviderError(`Claude API error ${error.status ?? ''}: ${error.message}`.trim(), (error.status ?? 500) >= 500);
  }
  return error instanceof Error ? error : new Error(String(error));
}

class ClaudeConversation implements Conversation {
  /** Append-only, exactly as the API returned it (thinking blocks included). */
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(private readonly options: ConversationOptions, private readonly createMessage: () => CreateMessage) {}

  async send(input: TurnInput, signal?: AbortSignal): Promise<AssistantTurn> {
    const userTurn: Anthropic.Beta.BetaMessageParam = { role: 'user', content: toUserContent(input) };
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.createMessage()(this.params([...this.messages, userTurn]), { signal });
    } catch (error) {
      throw toProviderError(error, this.options.model);
    }
    this.messages.push(userTurn, { role: 'assistant', content: response.content });
    return toTurn(response, this.options.model);
  }

  private params(messages: Anthropic.Beta.BetaMessageParam[]): MessageParams {
    const { model, system, tools, effort } = this.options;
    return {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      })),
      messages,
      // The tool list and system prompt are stable, so the growing history caches well.
      cache_control: { type: 'ephemeral' },
      ...(effort ? { output_config: { effort } } : {}),
      ...(FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }
}

export interface AnthropicProviderOptions {
  id: string;
  /** Explicit key; when absent the SDK resolves ANTHROPIC_API_KEY / `ant auth login` itself. */
  apiKey?: string;
  /** Test seam: replaces the real API call. */
  createMessage?: CreateMessage;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly isLocal = false;
  private create: CreateMessage | null;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id;
    this.create = options.createMessage ?? null;
  }

  startConversation(options: ConversationOptions): Conversation {
    return new ClaudeConversation(options, () => this.createMessage());
  }

  /** The client is built on first use, so a missing key fails the run (visibly) instead of the server. */
  private createMessage(): CreateMessage {
    if (!this.create) {
      const client = new Anthropic(this.options.apiKey ? { apiKey: this.options.apiKey } : {});
      this.create = (params, requestOptions) => client.beta.messages.create(params, requestOptions);
    }
    return this.create;
  }
}
