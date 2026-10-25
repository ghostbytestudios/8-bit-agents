import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage, Skill } from '@harness/protocol';
import { describe, expect, it } from 'vitest';
import { RunHub } from './hub';
import { SkillStore, parseSkill, serializeSkill, slugify } from './skills';
import { WorkspaceError } from './workspace';

const quiet = { warn: () => undefined, error: () => undefined };

async function openStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  return SkillStore.open(dataDir, quiet);
}

const DRAFT = { name: 'Python style', description: 'How we write Python: type hints, pytest.', roles: ['worker' as const], enabled: true, body: 'Use type hints.\n' };

describe('SKILL.md files', () => {
  it('round-trips through the frontmatter, including colons and quotes', () => {
    const skill: Skill = { id: 'py', name: 'Py: "style"', description: 'When: writing # Python', roles: ['boss', 'worker'], enabled: false, body: 'Body\n' };
    expect(parseSkill('py', serializeSkill(skill))).toEqual(skill);
  });

  it('reads a skill made for Claude Code: no roles or enabled line means everyone, on', () => {
    const text = '---\nname: pdf-tools\ndescription: Fill in PDF forms\nlicense: MIT\n---\n# PDF\nSteps.';
    expect(parseSkill('pdf-tools', text)).toEqual({
      id: 'pdf-tools', name: 'pdf-tools', description: 'Fill in PDF forms', roles: ['boss', 'architect', 'worker'], enabled: true, body: '# PDF\nSteps.',
    });
  });

  it('refuses a file without frontmatter or a description, and says why', () => {
    const reasons: string[] = [];
    expect(parseSkill('a', 'just text', (why) => reasons.push(why))).toBeNull();
    expect(parseSkill('b', '---\nname: b\n---\nbody', (why) => reasons.push(why))).toBeNull();
    expect(reasons).toHaveLength(2);
  });

  it('makes folder names from skill names', () => {
    expect(slugify('Our Python style!')).toBe('our-python-style');
    expect(slugify('???')).toBe('skill');
  });
});

describe('SkillStore', () => {
  it('creates, edits and deletes skills on disk', async () => {
    const store = await openStore();
    const created = await store.save(DRAFT);
    expect(created.id).toBe('python-style');
    expect(await readFile(path.join(store.dir, 'python-style', 'SKILL.md'), 'utf8')).toContain('name: "Python style"');

    await store.save({ ...created, body: 'Use ruff too.' });
    expect((await store.list())[0].body).toBe('Use ruff too.\n');

    await store.delete('python-style');
    expect(await store.list()).toEqual([]);
  });

  it('only gives a role its enabled skills', async () => {
    const store = await openStore();
    await store.save(DRAFT);
    await store.save({ ...DRAFT, name: 'Planning', roles: ['architect'] });
    await store.save({ ...DRAFT, name: 'Old notes', enabled: false });
    expect((await store.forRole('worker')).map((skill) => skill.name)).toEqual(['Python style']);
    expect((await store.forRole('architect')).map((skill) => skill.name)).toEqual(['Planning']);
  });

  it('refuses duplicate names and unknown ids', async () => {
    const store = await openStore();
    await store.save(DRAFT);
    await expect(store.save({ ...DRAFT, name: 'python STYLE' })).rejects.toThrow('already a skill called');
    await expect(store.save({ ...DRAFT, id: 'missing' })).rejects.toThrow('no skill "missing"');
    await expect(store.delete('missing')).rejects.toThrow('no skill "missing"');
  });

  it('never reuses a dropped-in folder, and keeps its other files on delete', async () => {
    const store = await openStore();
    await mkdir(path.join(store.dir, 'python-style'));
    await writeFile(path.join(store.dir, 'python-style', 'notes.txt'), 'mine');
    const created = await store.save(DRAFT);
    expect(created.id).toBe('python-style-2');

    await writeFile(path.join(store.dir, 'python-style-2', 'helper.py'), 'print(1)');
    await store.delete('python-style-2');
    expect(await readFile(path.join(store.dir, 'python-style-2', 'helper.py'), 'utf8')).toBe('print(1)');
    expect(await readFile(path.join(store.dir, 'python-style', 'notes.txt'), 'utf8')).toBe('mine');
  });
});

describe('RunHub file and skill commands', () => {
  const noRuns = () => {
    throw new Error('no runs here');
  };

  it('lists and edits skills, broadcasting every change', async () => {
    const skills = await openStore();
    const hub = new RunHub(noRuns, { skills }, quiet);
    const received: ServerMessage[] = [];
    hub.connect((message) => received.push(message));

    expect(await hub.handle({ type: 'skill.save', skill: DRAFT })).toEqual({ ok: true });
    expect(received.at(-1)).toMatchObject({ type: 'skills', skills: [{ id: 'python-style' }] });

    const replies: ServerMessage[] = [];
    await hub.handle({ type: 'skills.list' }, (message) => replies.push(message));
    expect(replies).toMatchObject([{ type: 'skills', skills: [{ name: 'Python style' }] }]);

    expect(await hub.handle({ type: 'skill.delete', id: 'nope' })).toEqual({ ok: false, error: 'There is no skill "nope".' });
  });

  it('replies with the workspace listing and file contents, and reports bad paths', async () => {
    const files = {
      list: async () => ({ root: '/ws', entries: ['src/', 'src/app.py'], truncated: false }),
      read: async (relative: string) => {
        if (relative === 'src/app.py') return 'print(1)';
        throw new WorkspaceError(`"${relative}" does not exist.`);
      },
    };
    const hub = new RunHub(noRuns, { files }, quiet);
    const replies: ServerMessage[] = [];
    const reply = (message: ServerMessage) => replies.push(message);

    await hub.handle({ type: 'files.list' }, reply);
    await hub.handle({ type: 'file.read', path: 'src/app.py' }, reply);
    expect(replies).toEqual([
      { type: 'files', root: '/ws', entries: ['src/', 'src/app.py'], truncated: false },
      { type: 'file', path: 'src/app.py', content: 'print(1)' },
    ]);
    expect(await hub.handle({ type: 'file.read', path: 'gone.txt' }, reply)).toEqual({ ok: false, error: '"gone.txt" does not exist.' });
  });

  it('says so when a service is missing', async () => {
    const hub = new RunHub(noRuns, {}, quiet);
    expect(await hub.handle({ type: 'files.list' })).toEqual({ ok: false, error: 'The file cabinet is not available in this mode.' });
  });
});
