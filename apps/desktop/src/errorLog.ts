import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

/** Past this size the log is moved to `<name>.old.log` and a fresh one starts. */
export const MAX_LOG_BYTES = 1_000_000;

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = Pick<Console, LogLevel>;

// API keys must never end up in a file someone may paste into an issue.
const KEY_PATTERNS = [/\b(sk-)[A-Za-z0-9_-]{8,}/g, /\b(gsk_)[A-Za-z0-9]{8,}/g, /\b(Bearer )[A-Za-z0-9._~+/=-]{8,}/gi];

export function redact(text: string): string {
  return KEY_PATTERNS.reduce((result, pattern) => result.replace(pattern, '$1[hidden]'), text);
}

export function formatLine(level: LogLevel, parts: readonly unknown[], now: Date): string {
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(format(...parts))}\n`;
}

/**
 * The app's own log file: startup, warnings, errors and crashes, kept on this computer only.
 * Writes are synchronous so the last line before a crash still lands.
 */
export class ErrorLog {
  private isBroken = false;

  constructor(readonly file: string, private readonly maxBytes = MAX_LOG_BYTES) {}

  write(level: LogLevel, parts: readonly unknown[]): void {
    if (this.isBroken) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfFull();
      appendFileSync(this.file, formatLine(level, parts, new Date()), { mode: 0o600 });
    } catch (error) {
      // A full or read-only disk shouldn't take the app down; say so once and stop trying.
      this.isBroken = true;
      console.error(`[desktop] Can't write the log file ${this.file}:`, error);
    }
  }

  private rotateIfFull(): void {
    const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
    if (size < this.maxBytes) return;
    renameSync(this.file, this.file.replace(/\.log$/, '') + '.old.log');
  }
}

/** A console that also writes every line to the log file. */
export function teeLogger(target: Logger, errorLog: ErrorLog): Logger {
  const tee = (level: LogLevel) => (...parts: unknown[]) => {
    target[level](...parts);
    errorLog.write(level, parts);
  };
  return { info: tee('info'), warn: tee('warn'), error: tee('error') };
}
