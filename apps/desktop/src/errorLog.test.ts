import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorLog, formatLine, redact, teeLogger } from './errorLog';

const tempLog = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'errorlog-')), 'logs', 'main.log');

describe('redact', () => {
  it('hides anything shaped like an API key', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmnop failed')).toBe('key sk-[hidden] failed');
    expect(redact('key sk-proj1234567890abcdef')).toBe('key sk-[hidden]');
    expect(redact('gsk_abcdefghijkl and Bearer abc.def.ghi.jkl')).toBe('gsk_[hidden] and Bearer [hidden]');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('Settings saved to disk-1')).toBe('Settings saved to disk-1');
  });
});

describe('formatLine', () => {
  it('stamps the time and level and keeps error stacks', () => {
    const line = formatLine('error', ['[desktop] boom', new Error('kaput')], new Date('2026-10-25T10:00:00Z'));
    expect(line.startsWith('2026-10-25T10:00:00.000Z ERROR [desktop] boom Error: kaput')).toBe(true);
    expect(line).toContain('errorLog.test.ts');
    expect(line.endsWith('\n')).toBe(true);
  });
});

describe('ErrorLog', () => {
  it('creates the folder and appends lines', async () => {
    const file = await tempLog();
    const log = new ErrorLog(file);
    log.write('info', ['started']);
    log.write('warn', ['careful']);
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/INFO {2}started\n.*WARN {2}careful\n$/);
  });

  it('moves a full log aside and starts a new one', async () => {
    const file = await tempLog();
    const log = new ErrorLog(file, 10);
    log.write('info', ['first line is long enough']);
    log.write('info', ['second']);
    expect(await readFile(file.replace('main.log', 'main.old.log'), 'utf8')).toContain('first line');
    expect(await readFile(file, 'utf8')).not.toContain('first line');
  });

  it('keeps the app running when the file cannot be written', async () => {
    // The log's "folder" is an existing file, so every write fails.
    const blocker = await tempLog();
    new ErrorLog(blocker).write('info', ['x']);
    const log = new ErrorLog(path.join(blocker, 'nested.log'));
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => log.write('error', ['y'])).not.toThrow();
      expect(() => log.write('error', ['z'])).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});

describe('teeLogger', () => {
  it('writes to both the console and the file', async () => {
    const file = await tempLog();
    const seen: unknown[][] = [];
    const target = { info: (...parts: unknown[]) => seen.push(parts), warn: () => {}, error: () => {} };
    teeLogger(target, new ErrorLog(file)).info('hello', 42);
    expect(seen).toEqual([['hello', 42]]);
    expect(await readFile(file, 'utf8')).toContain('hello 42');
  });
});
