import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspace, WorkspaceError, scrubEnv } from './workspace';

let base: string;
let workspace: Workspace;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'harness-ws-'));
  workspace = await Workspace.open(path.join(base, 'ws'));
});

describe('Workspace paths', () => {
  it('reads back what it writes, creating folders as needed', async () => {
    await workspace.writeFile('src/app/main.ts', 'export {};');
    expect(await workspace.readFile('src/app/main.ts')).toBe('export {};');
    expect(await workspace.listFiles()).toEqual(['src/', 'src/app/', 'src/app/main.ts']);
  });

  it.each(['../outside.txt', 'a/../../outside.txt', '..'])('refuses to escape with %s', async (escape) => {
    await expect(workspace.writeFile(escape, 'x')).rejects.toBeInstanceOf(WorkspaceError);
    expect(existsSync(path.join(base, 'outside.txt'))).toBe(false);
  });

  it.each(['/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', '\\\\server\\share\\x'])('refuses absolute path %s', async (absolute) => {
    await expect(workspace.readFile(absolute)).rejects.toThrow(/relative to the workspace/);
  });

  it('refuses to follow a link that points outside the workspace', async () => {
    const outside = path.join(base, 'secret');
    await mkdir(outside);
    await writeFile(path.join(outside, 'key.txt'), 'hunter2');
    // A junction needs no admin rights on Windows and is a plain dir symlink elsewhere.
    await symlink(outside, path.join(workspace.root, 'link'), 'junction');

    await expect(workspace.readFile('link/key.txt')).rejects.toThrow(/leads outside/);
    await expect(workspace.writeFile('link/new.txt', 'x')).rejects.toThrow(/leads outside/);
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it.each(['.git/hooks/pre-commit', '.vscode/tasks.json', '.github/workflows/ci.yml', 'pkg/.npmrc', '.husky/pre-push'])(
    'refuses to write tool configuration %s',
    async (protectedPath) => {
      await expect(workspace.writeFile(protectedPath, 'x')).rejects.toThrow(/protected/);
    },
  );

  it.each(['notes.txt:hidden', 'con', 'src/nul.txt', 'LPT1'])('refuses stream or device path %s', async (odd) => {
    await expect(workspace.writeFile(odd, 'x')).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('caps writes and reports missing files clearly', async () => {
    await expect(workspace.writeFile('big.txt', 'x'.repeat(1_000_001))).rejects.toThrow(/limit/);
    await expect(workspace.readFile('nope.txt')).rejects.toThrow(/does not exist/);
  });
});

describe('Workspace commands', () => {
  it('runs in the workspace and reports the exit code', async () => {
    await workspace.writeFile('marker.txt', 'here');
    const result = await workspace.runCommand(process.platform === 'win32' ? 'type marker.txt' : 'cat marker.txt');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('here');
  });
});

describe('scrubEnv', () => {
  it('drops named credentials and anything that looks secret', () => {
    const env = { PATH: '/bin', OPENROUTER_API_KEY: 'k', MY_CUSTOM: 'c', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', DATABASE_URL: 'postgres://u:p@h', HOME: '/h' };
    expect(scrubEnv(env, ['MY_CUSTOM'])).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
