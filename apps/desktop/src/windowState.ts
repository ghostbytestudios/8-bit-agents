import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, writeFileAtomic } from '@harness/server/app';
import { z } from 'zod';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WindowStateSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  isMaximized: z.boolean(),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

export const MIN_WINDOW = { width: 960, height: 600 } as const;
const DEFAULT_SIZE = { width: 1440, height: 900 } as const;
const FILE = 'window-state.json';
/** How much of the title bar must be on a screen for a saved position to count. */
const MIN_VISIBLE_PX = 120;
const TITLE_BAR_PX = 32;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Where the window should open: the saved bounds when they still land on a connected
 * screen (monitors get unplugged), otherwise a default size centred by the OS.
 */
export function initialBounds(saved: WindowState | null, workAreas: readonly Rect[]): Partial<Rect> & { width: number; height: number } {
  if (saved) {
    const width = Math.max(saved.width, MIN_WINDOW.width);
    const height = Math.max(saved.height, MIN_WINDOW.height);
    const titleBar: Rect = { x: saved.x, y: saved.y, width, height: TITLE_BAR_PX };
    const isVisible = workAreas.some((area) => {
      const shared = overlap(titleBar, area);
      return shared.width >= MIN_VISIBLE_PX && shared.height > 0;
    });
    if (isVisible) return { x: saved.x, y: saved.y, width, height };
  }
  const area = workAreas[0];
  return {
    width: area ? Math.min(DEFAULT_SIZE.width, area.width) : DEFAULT_SIZE.width,
    height: area ? Math.min(DEFAULT_SIZE.height, area.height) : DEFAULT_SIZE.height,
  };
}

export async function loadWindowState(dir: string): Promise<WindowState | null> {
  const raw = await readFile(path.join(dir, FILE), 'utf8').catch(() => null);
  const parsed = WindowStateSchema.safeParse(raw === null ? null : parseJson(raw));
  return parsed.success ? parsed.data : null;
}

export function saveWindowState(dir: string, state: WindowState): Promise<void> {
  return writeFileAtomic(path.join(dir, FILE), JSON.stringify(state));
}
