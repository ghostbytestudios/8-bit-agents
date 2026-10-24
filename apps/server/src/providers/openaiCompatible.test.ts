import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderError } from './types';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] };
}

function fakeServer(replies: Array<{ status?: number; json: unknown }>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (!reply) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const toolCallReply = (args: unknown) => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: { content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: args } }] },
  }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
});
const textReply = (text: string) => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
const TOOLS = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('OpenAICompatibleProvider', () => {
  it('talks chat completions with function tools and tool-role results (Ollama style)', async () => {
    const { fetchImpl, sent } = fakeServer([{ json: toolCallReply('{"path":"a.txt"}') }, { json: textReply('Done') }]);
    const provider = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/', fetch: fetchImpl });
    const chat = provider.startConversation({ model: 'qwen2.5-coder', system: 'You help.', tools: TOOLS });

    const first = await chat.send({ text: 'read it' });
    expect(first).toMatchObject({ stop: 'tool_use', toolCalls: [{ id: 'call_a', name: 'read_file', input: { path: 'a.txt' } }] });
    expect(first.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0 });
    await chat.send({ toolResults: [{ callId: 'call_a', content: 'hello', isError: false }] });

    expect(sent[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(sent[0].body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: TOOLS[0].inputSchema } }]);
    expect(sent[1].body.messages.map((entry) => entry.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(sent[1].body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'hello' });
    expect(sent[0].headers.authorization).toBeUndefined();
  });

  it('is local for loopback servers and remote otherwise', () => {
    expect(new OpenAICompatibleProvider({ id: 'a', baseUrl: 'http://localhost:1234/v1' }).isLocal).toBe(true);
    expect(new OpenAICompatibleProvider({ id: 'b', baseUrl: 'https://openrouter.ai/api/v1' }).isLocal).toBe(false);
  });

  it('accepts object arguments and hands invalid JSON on for the loop to reject', async () => {
    const { fetchImpl } = fakeServer([{ json: toolCallReply({ path: 'x' }) }, { json: toolCallReply('{not json') }]);
    const chat = new OpenAICompatibleProvider({ id: 'o', baseUrl: 'http://127.0.0.1:1/v1', fetch: fetchImpl })
      .startConversation({ model: 'm', system: 's', tools: TOOLS });
    expect((await chat.send({ text: 'a' })).toolCalls[0].input).toEqual({ path: 'x' });
    expect((await chat.send({ toolResults: [{ callId: 'call_a', content: 'ok', isError: false }] })).toolCalls[0].input).toEqual({ invalidJson: '{not json' });
  });

  it('sends the API key from config and prices metered models', async () => {
    const { fetchImpl, sent } = fakeServer([{ json: { ...textReply('hi'), usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } } }]);
    const provider = new OpenAICompatibleProvider({
      id: 'router', baseUrl: 'https://example.test/v1', apiKey: 'sk-test', fetch: fetchImpl,
      pricing: { 'big-model': { inputPerMTok: 1, outputPerMTok: 3 } },
    });
    const turn = await provider.startConversation({ model: 'big-model', system: 's', tools: [] }).send({ text: 'hi' });
    expect(sent[0].headers.authorization).toBe('Bearer sk-test');
    expect(sent[0].body.tools).toBeUndefined();
    expect(turn.usage.costUsd).toBeCloseTo(4);
  });

  it('turns failures into readable errors', async () => {
    const offline = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', fetch: fakeServer([]).fetchImpl });
    await expect(offline.startConversation({ model: 'm', system: 's', tools: [] }).send({ text: 'x' })).rejects.toThrow(/Is the model server running/);

    const missing = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', fetch: fakeServer([{ status: 404, json: { error: 'model not found' } }]).fetchImpl });
    await expect(missing.startConversation({ model: 'llama9', system: 's', tools: [] }).send({ text: 'x' })).rejects.toThrow(/ollama pull llama9/);

    const garbage = new OpenAICompatibleProvider({ id: 'x', baseUrl: 'http://127.0.0.1:1/v1', fetch: fakeServer([{ json: { hello: 'world' } }]).fetchImpl });
    await expect(garbage.startConversation({ model: 'm', system: 's', tools: [] }).send({ text: 'x' })).rejects.toBeInstanceOf(ProviderError);
  });
});
