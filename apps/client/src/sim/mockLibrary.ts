import { SkillDraftSchema, type HarnessCommand, type Skill, type SkillDraft, type SkillRole } from '@harness/protocol';
import type { Ack, LibraryReply, LibrarySource } from '../net/socketFeed';

/**
 * The demo's file cabinet and skill shelf: a pretend todo-app workspace and a few sample
 * skills, all in memory. Visitors can edit skills; nothing is saved past the page.
 */

export const DEMO_ROOT = '~/8BitAgents/workspace (demo)';

export const DEMO_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Todo app\n\nA small todo app: REST API, web UI and tests.\n\n```\nnpm install\nnpm test\nnpm start\n```\n',
  'package.json': '{\n  "name": "todo-app",\n  "type": "module",\n  "scripts": {\n    "start": "node dist/server.js",\n    "test": "vitest run"\n  }\n}\n',
  'docs/requirements.md': '# Requirements\n\n- Add, edit, complete and delete todos\n- Todos survive a restart (SQLite)\n- Works on a phone\n',
  'src/server.ts': "import express from 'express';\nimport { todos } from './routes/todos';\n\nconst app = express();\napp.use(express.json());\napp.use('/api/todos', todos);\napp.listen(3000);\n",
  'src/routes/todos.ts': "import { Router } from 'express';\nimport { TodoInput } from '../validation';\n\nexport const todos = Router();\n\ntodos.post('/', (req, res) => {\n  const input = TodoInput.parse(req.body);\n  res.status(201).json(input);\n});\n",
  'src/db/schema.ts': "export const SCHEMA = `\n  CREATE TABLE IF NOT EXISTS todos (\n    id INTEGER PRIMARY KEY,\n    title TEXT NOT NULL,\n    done INTEGER NOT NULL DEFAULT 0\n  );\n`;\n",
  'src/validation.ts': "import { z } from 'zod';\n\nexport const TodoInput = z.object({ title: z.string().min(1).max(200) });\n",
  'src/ui/TodoList.tsx': "export function TodoList({ todos }: { todos: Todo[] }) {\n  return <ul>{todos.map((todo) => <li key={todo.id}>{todo.title}</li>)}</ul>;\n}\n",
  'src/ui/TodoForm.tsx': "export function TodoForm({ onAdd }: { onAdd(title: string): void }) {\n  return <form onSubmit={(event) => { event.preventDefault(); onAdd('New todo'); }} />;\n}\n",
  'tests/todos.test.ts': "import { describe, expect, it } from 'vitest';\n\ndescribe('POST /api/todos', () => {\n  it('creates a todo', () => {\n    expect(true).toBe(true);\n  });\n});\n",
};

const SAMPLE_SKILLS: readonly Skill[] = [
  {
    id: 'planning-checklist', name: 'Planning checklist', description: 'Before writing a plan: what to check so workers can build in parallel.', roles: ['architect', 'boss'], enabled: true,
    body: '# Planning checklist\n\n- Read the README and any docs/ first.\n- Split by file, so two workers never edit the same one.\n- Write down every interface between files.\n',
  },
  {
    id: 'typescript-style', name: 'TypeScript style', description: 'How we write TypeScript: strict types, zod at the edges, small files.', roles: ['worker'], enabled: true,
    body: '# TypeScript style\n\n- `strict` mode, no `any`.\n- Validate anything from outside (requests, files) with zod.\n- One module per job; keep files under 300 lines.\n- Name things for what they mean, not their type.\n',
  },
  {
    id: 'writing-tests', name: 'Writing tests', description: 'When adding or changing behavior: write a vitest test that fails first.', roles: ['worker'], enabled: true,
    body: '# Writing tests\n\n1. Write the test first and watch it fail.\n2. Make it pass with the smallest change.\n3. Test behavior, not internals: inputs in, results out.\n',
  },
];

/** The same shape the server sends: folders end in "/", breadth-first. */
export function demoEntries(files: readonly string[] = Object.keys(DEMO_FILES)): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) folders.add(`${parts.slice(0, depth).join('/')}/`);
  }
  const depth = (entry: string) => entry.replace(/\/$/, '').split('/').length;
  return [...folders, ...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
}

export class MockLibrary implements LibrarySource {
  private skills: Skill[] = [...SAMPLE_SKILLS];
  private readonly listeners = new Set<(reply: LibraryReply) => void>();
  private readonly ackListeners = new Set<(ack: Ack) => void>();

  onLibrary(listener: (reply: LibraryReply) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAck(listener: (ack: Ack) => void): () => void {
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  /** Enabled skills a role has, for the mock agents to read. */
  skillNames(role: SkillRole): string[] {
    return this.skills.filter((skill) => skill.enabled && skill.roles.includes(role)).map((skill) => skill.name);
  }

  /** True when the command was one of ours. Replies arrive asynchronously, like the server's. */
  handle(command: HarnessCommand): boolean {
    switch (command.type) {
      case 'files.list':
        this.reply({ type: 'files', root: DEMO_ROOT, entries: demoEntries(), truncated: false });
        return true;
      case 'file.read': {
        const content = DEMO_FILES[command.path];
        if (content === undefined) this.refuse(`"${command.path}" does not exist.`);
        else this.reply({ type: 'file', path: command.path, content });
        return true;
      }
      case 'skills.list':
        this.publishSkills();
        return true;
      case 'skill.save':
        this.save(command.skill);
        return true;
      case 'skill.delete':
        this.skills = this.skills.filter((skill) => skill.id !== command.id);
        this.publishSkills();
        return true;
      default:
        return false;
    }
  }

  /** Mirrors the server's checks, so the demo refuses the same things. */
  private save(raw: SkillDraft): void {
    const parsed = SkillDraftSchema.safeParse(raw);
    if (!parsed.success) {
      this.refuse(parsed.error.issues[0]?.message ?? 'That skill is not valid.');
      return;
    }
    const draft = parsed.data;
    const name = draft.name.toLowerCase();
    const duplicate = this.skills.find((skill) => skill.id !== draft.id && skill.name.toLowerCase() === name);
    if (duplicate) {
      this.refuse(`There is already a skill called "${duplicate.name}".`);
      return;
    }
    const taken = new Set(this.skills.map((skill) => skill.id));
    let id = draft.id ?? slug(draft.name);
    for (let n = 2; !draft.id && taken.has(id); n++) id = `${slug(draft.name)}-${n}`;
    const skill: Skill = { ...draft, id };
    this.skills = [...this.skills.filter((existing) => existing.id !== id), skill].sort((a, b) => a.name.localeCompare(b.name));
    this.publishSkills();
  }

  private publishSkills(): void {
    this.reply({ type: 'skills', skills: [...this.skills] });
  }

  private reply(message: LibraryReply): void {
    queueMicrotask(() => this.listeners.forEach((listener) => listener(message)));
  }

  private refuse(error: string): void {
    const ack: Ack = { commandId: `mock-${Date.now()}`, ok: false, error };
    queueMicrotask(() => this.ackListeners.forEach((listener) => listener(ack)));
  }
}
