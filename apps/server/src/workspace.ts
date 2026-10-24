import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The only part of your disk agents can touch. Every path is resolved inside the
 * workspace root — after following symlinks — and anything that would escape is refused.
 */

const MAX_READ_BYTES = 100_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 300;
const BINARY_SNIFF_BYTES = 8_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_CHARS = 20_000;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
/** Environment variables that look like credentials (or connection strings carrying them) never reach agent shells. */
const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|_URL$|_URI$|DSN/i;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/**
 * Places agents may not write: files that make tools run code later (git hooks, editor
 * tasks, CI workflows, npm config), so an approved "npm test" can't be quietly rigged.
 */
const PROTECTED_PATHS = /^(\.git|\.vscode|\.idea|\.husky|\.github)(\/|$)|(^|\/)\.npmrc$/i;
const IS_WINDOWS = process.platform === 'win32';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(() => true, () => false);
}

/** The nearest ancestor (or the path itself) that exists on disk. */
async function deepestExisting(target: string): Promise<string> {
  let current = target;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** A copy of `env` without credentials: the named variables plus anything that looks secret. */
export function scrubEnv(env: NodeJS.ProcessEnv, credentialNames: readonly string[]): NodeJS.ProcessEnv {
  const blocked = new Set(credentialNames);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !blocked.has(name) && !SECRET_ENV_PATTERN.test(name)));
}

function capOutput(text: string): string {
  if (text.length <= MAX_COMMAND_OUTPUT_CHARS) return text;
  const half = MAX_COMMAND_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n… [${text.length - MAX_COMMAND_OUTPUT_CHARS} characters cut] …\n${text.slice(-half)}`;
}

/** `shell: true` wraps the command in a shell, so kill the whole process tree, not just the shell. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    // Negative pid: the whole process group (the shell was started detached as its leader).
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

export class Workspace {
  private constructor(readonly root: string, private readonly credentialNames: readonly string[]) {}

  /** Creates the folder if needed; `root` is stored as its real path so symlink checks compare like with like. */
  static async open(dir: string, credentialNames: readonly string[] = []): Promise<Workspace> {
    await mkdir(dir, { recursive: true });
    return new Workspace(await realpath(dir), credentialNames);
  }

  async resolve(relative: string): Promise<string> {
    if (relative.includes('\0')) throw new WorkspaceError('Paths cannot contain NUL characters.');
    if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\\\')) {
      throw new WorkspaceError(`Use a path relative to the workspace, not "${relative}".`);
    }
    // ":" would reach Windows alternate data streams; device names reach hardware, not files.
    if (relative.includes(':')) throw new WorkspaceError(`Paths cannot contain ":" ("${relative}").`);
    if (relative.split(/[\\/]/).some((segment) => WINDOWS_DEVICE_NAME.test(segment))) {
      throw new WorkspaceError(`"${relative}" uses a reserved device name.`);
    }
    const target = path.resolve(this.root, relative || '.');
    if (!isInside(this.root, target)) throw new WorkspaceError(`"${relative}" is outside the workspace.`);
    // A symlink inside the workspace could still point outside it.
    const real = await realpath(await deepestExisting(target));
    if (!isInside(this.root, real)) throw new WorkspaceError(`"${relative}" leads outside the workspace.`);
    return target;
  }

  /** Files under `dir`, recursively (skipping node_modules/.git), as workspace-relative paths. */
  async listFiles(dir = '.'): Promise<string[]> {
    const start = await this.resolve(dir);
    const results: string[] = [];
    const queue = [start];
    while (queue.length && results.length < MAX_LIST_ENTRIES) {
      const current = queue.shift() as string;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        const shown = path.relative(this.root, full).split(path.sep).join('/');
        if (entry.isSymbolicLink()) results.push(`${shown} (link)`);
        else if (entry.isDirectory()) {
          results.push(`${shown}/`);
          if (!SKIPPED_DIRS.has(entry.name)) queue.push(full);
        } else results.push(shown);
        if (results.length >= MAX_LIST_ENTRIES) break;
      }
    }
    if (results.length >= MAX_LIST_ENTRIES) results.push(`… (stopped after ${MAX_LIST_ENTRIES} entries)`);
    return results;
  }

  async readFile(relative: string): Promise<string> {
    const target = await this.resolve(relative);
    const info = await stat(target).catch(() => null);
    if (!info) throw new WorkspaceError(`"${relative}" does not exist.`);
    if (!info.isFile()) throw new WorkspaceError(`"${relative}" is not a file.`);
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return `[binary file, ${info.size} bytes]`;
      const text = buffer.toString('utf8');
      return info.size > MAX_READ_BYTES ? `${text}\n… [file is ${info.size} bytes; only the first ${MAX_READ_BYTES} shown]` : text;
    } finally {
      await handle.close();
    }
  }

  async writeFile(relative: string, content: string): Promise<number> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError(`Refusing to write ${bytes} bytes (limit ${MAX_WRITE_BYTES}).`);
    const target = await this.resolve(relative);
    if (target === this.root) throw new WorkspaceError('Give a file name to write.');
    const shown = path.relative(this.root, target).split(path.sep).join('/');
    if (PROTECTED_PATHS.test(shown)) throw new WorkspaceError(`"${shown}" is protected: agents cannot write tool or editor configuration.`);
    await mkdir(path.dirname(target), { recursive: true });
    // Re-check after creating folders: nothing in the new chain may lead outside.
    await this.resolve(relative);
    await writeFile(target, content, 'utf8');
    return bytes;
  }

  /** Runs a shell command in the workspace with a timeout and a credential-free environment. */
  runCommand(command: string, signal?: AbortSignal): Promise<CommandResult> {
    if (signal?.aborted) return Promise.resolve({ exitCode: null, output: 'Run stopped before the command started.', timedOut: false });
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.root,
        shell: true,
        windowsHide: true,
        detached: !IS_WINDOWS,
        env: scrubEnv(process.env, this.credentialNames),
      });
      let output = '';
      let timedOut = false;
      const collect = (chunk: Buffer) => {
        if (output.length < MAX_COMMAND_OUTPUT_CHARS * 4) output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const kill = () => killTree(child.pid);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, COMMAND_TIMEOUT_MS);
      signal?.addEventListener('abort', kill, { once: true });
      child.on('error', (error) => {
        output += `\n${error.message}`;
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({ exitCode, output: capOutput(output), timedOut });
      });
    });
  }
}
