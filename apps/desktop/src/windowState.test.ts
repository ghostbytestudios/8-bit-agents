import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialBounds, loadWindowState, saveWindowState, type WindowState } from './windowState';

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

describe('initialBounds', () => {
  it('reopens where the window was when that spot is still on screen', () => {
    const saved: WindowState = { x: 100, y: 80, width: 1200, height: 800, isMaximized: false };
    expect(initialBounds(saved, [SCREEN])).toEqual({ x: 100, y: 80, width: 1200, height: 800 });
  });

  it('drops a position on a monitor that is no longer connected', () => {
    const saved: WindowState = { x: 2500, y: 100, width: 1200, height: 800, isMaximized: false };
    expect(initialBounds(saved, [SCREEN])).toEqual({ width: 1440, height: 900 });
  });

  it('never opens smaller than the minimum or bigger than the screen', () => {
    const tiny: WindowState = { x: 10, y: 10, width: 200, height: 100, isMaximized: false };
    expect(initialBounds(tiny, [SCREEN])).toMatchObject({ width: 960, height: 600 });
    expect(initialBounds(null, [{ x: 0, y: 0, width: 1280, height: 720 }])).toEqual({ width: 1280, height: 720 });
  });
});

describe('window state file', () => {
  it('round-trips and ignores a damaged file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-window-'));
    expect(await loadWindowState(dir)).toBeNull();
    const state: WindowState = { x: 5, y: 6, width: 1000, height: 700, isMaximized: true };
    await saveWindowState(dir, state);
    expect(await loadWindowState(dir)).toEqual(state);
    await writeFile(path.join(dir, 'window-state.json'), '{"x":"left"}');
    expect(await loadWindowState(dir)).toBeNull();
  });
});
