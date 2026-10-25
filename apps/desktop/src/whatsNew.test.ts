import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import desktopPackage from '../package.json';
import { CHANGELOG, compareVersions, formatNotes, notesFor, notesSince, takeUnseenNotes, type ReleaseNotes } from './whatsNew';

const LOG: ReleaseNotes[] = [
  { version: '0.10.0', notes: ['ten'] },
  { version: '0.9.0', notes: ['nine'] },
  { version: '0.2.0', notes: ['two'] },
];

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.2')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0-beta.1', '0.2.0')).toBe(-1);
  });
});

describe('notesSince / notesFor', () => {
  it('lists every release after the last one that ran', () => {
    expect(notesSince(LOG, '0.2.0', '0.10.0').map((release) => release.version)).toEqual(['0.10.0', '0.9.0']);
    expect(notesSince(LOG, '0.10.0', '0.10.0')).toEqual([]);
  });

  it('falls back to the newest older release', () => {
    expect(notesFor(LOG, '0.9.5')?.version).toBe('0.9.0');
    expect(notesFor(LOG, '0.1.0')).toBeNull();
  });

  it('formats notes as bullet lists', () => {
    expect(formatNotes([LOG[0]])).toBe('Version 0.10.0\n• ten');
  });
});

describe('takeUnseenNotes', () => {
  it('shows nothing on a fresh install, then what changed after an update', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'whatsnew-'));
    expect(await takeUnseenNotes(dir, '0.2.0', LOG)).toEqual([]);
    expect(await takeUnseenNotes(dir, '0.2.0', LOG)).toEqual([]);
    expect((await takeUnseenNotes(dir, '0.10.0', LOG)).map((release) => release.version)).toEqual(['0.10.0', '0.9.0']);
    expect(JSON.parse(await readFile(path.join(dir, 'last-version.json'), 'utf8'))).toEqual({ version: '0.10.0' });
  });
});

describe('CHANGELOG', () => {
  it('has notes for the version being shipped', () => {
    expect(CHANGELOG[0].version).toBe(desktopPackage.version);
  });
});
