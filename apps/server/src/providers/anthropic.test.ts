import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, claudeCostUsd } from './anthropic';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

function message(content: unknown[], stopReason: string, model = 'claude-opus-5-5'): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

function recordingProvider(responses: Anthropic.Beta.BetaMessage[]) {
  const requests: Params[] = [];
  const provider = new AnthropicProvider({
    id: 'claude',
    createMessage: async (params) => {
      // Snapshot: the provider must not mutate what it already sent.
      requests.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      return next;
    },
  });
  return { provider, requests };
}

const TOOLS = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('AnthropicProvider', () => {
  it('maps tool calls and sends every result back in one user message', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const { provider, requests } = recordingProvider([
      message([thinking, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: 'b' } }], 'tool_use'),
      message([{ type: 'text', text: 'All read.' }], 'end_turn'),
    ]);
    const chat = provider.startConversation({ model: 'claude-opus-5-5', system: 'sys', tools: TOOLS, effort: 'high' });

    const first = await chat.send({ text: 'go' });
    expect(first.stop).toBe('tool_use');
    expect(first.toolCalls.map((call) => call.id)).toEqual(['tu_1', 'tu_2']);

    const second = await chat.send({
      toolResults: [{ callId: 'tu_1', content: 'A', isError: false }, { callId: 'tu_2', content: 'nope', isError: true }],
    });
    expect(second).toMatchObject({ text: 'All read.', stop: 'done' });

    const replay = requests[1].messages;
    expect(replay).toHaveLength(3);
    // The assistant turn goes back exactly as received, thinking block included.
    expect(replay[1]).toEqual({ role: 'assistant', content: expect.arrayContaining([thinking]) });
    expect(replay[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'A', is_error: false },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'nope', is_error: true },
      ],
    });
  });

  it('sets effort, caching and refusal fallbacks, and never sends sampling params', async () => {
    const { provider, requests } = recordingProvider([message([{ type: 'text', text: 'hi' }], 'end_turn')]);
    await provider.startConversation({ model: 'claude-opus-5-5', system: 'sys', tools: TOOLS, effort: 'high' }).send({ text: 'hi' });

    const params = requests[0] as Params & { temperature?: number; top_p?: number };
    expect(params.output_config).toEqual({ effort: 'high' });
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
  });

  it('leaves fallbacks off for models that do not accept them', async () => {
    const { provider, requests } = recordingProvider([message([{ type: 'text', text: 'hi' }], 'end_turn', 'claude-haiku-5-5')]);
    await provider.startConversation({ model: 'claude-haiku-5-5', system: 'sys', tools: [] }).send({ text: 'hi' });
    expect(requests[0].fallbacks).toBeUndefined();
    expect(requests[0].betas).toBeUndefined();
  });

  it('reports refusals as a stop reason', async () => {
    const { provider } = recordingProvider([message([], 'refusal')]);
    const turn = await provider.startConversation({ model: 'claude-opus-5-5', system: 's', tools: [] }).send({ text: 'x' });
    expect(turn.stop).toBe('refused');
  });

  it('explains a missing key instead of passing the raw SDK error on', async () => {
    const provider = new AnthropicProvider({
      id: 'claude',
      createMessage: async () => {
        throw new Error('Could not resolve authentication method. Expected one of apiKey');
      },
    });
    const chat = provider.startConversation({ model: 'claude-opus-5-5', system: 's', tools: [] });
    await expect(chat.send({ text: 'x' })).rejects.toThrow(/add a Claude API key in Settings › Models/);
  });

  it('does not keep a turn in the history when the request fails', async () => {
    const { provider, requests } = recordingProvider([message([{ type: 'text', text: 'ok' }], 'end_turn')]);
    const chat = provider.startConversation({ model: 'claude-opus-5-5', system: 's', tools: [] });
    await chat.send({ text: 'one' });
    await expect(chat.send({ text: 'two' })).rejects.toThrow();
    expect(requests[0].messages).toHaveLength(1);
  });
});

describe('claudeCostUsd', () => {
  const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
    ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }) as Anthropic.Beta.BetaUsage;

  it('prices Opus 5.5 at $4 / $20 per million tokens', () => {
    expect(claudeCostUsd('claude-opus-5-5', usage(1_000_000, 1_000_000))).toBeCloseTo(24);
  });

  it('bills cache reads at 10% and cache writes at 125% of input', () => {
    expect(claudeCostUsd('claude-sonnet-5-5', usage(0, 0, 1_000_000, 1_000_000))).toBeCloseTo(2 * 0.1 + 2 * 1.25);
  });

  it('uses the higher Haiku 5.5 rate for prompts over 100K tokens', () => {
    expect(claudeCostUsd('claude-haiku-5-5', usage(200_000, 0))).toBeCloseTo(0.1);
  });

  it('returns 0 for unknown models rather than guessing', () => {
    expect(claudeCostUsd('claude-unknown', usage(1_000, 1_000))).toBe(0);
  });
});
