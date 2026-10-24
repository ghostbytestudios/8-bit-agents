import { z } from 'zod';
import type { HumanInputKind } from '@harness/protocol';
import type { ToolSpec } from './providers/types';
import type { Workspace } from './workspace';

/**
 * What agents can do. Each tool is a zod schema (models' arguments are validated before
 * anything runs — local models in particular get this wrong) plus a handler.
 */

const MAX_FILE_CHARS = 1_000_000;
/** Control characters (incl. newlines), bidi embeddings/overrides/isolates, zero-width marks. */
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

export interface NewTask {
  title: string;
  details: string;
}

/** The run's side of the tools (implemented by the orchestrator). */
export interface RunPort {
  readonly workspace: Workspace;
  createTasks(agentId: string, tasks: readonly NewTask[]): string;
  writePlan(agentId: string, markdown: string): void;
  askHuman(agentId: string, prompt: string, options: readonly string[], kind: HumanInputKind): Promise<string>;
  askArchitect(agentId: string, question: string): Promise<string>;
  completeTask(agentId: string, summary: string, isSuccess: boolean): void;
  finishRun(agentId: string, summary: string): void;
  answerQuestion(agentId: string, answer: string): void;
}

export interface ToolContext {
  agentId: string;
  run: RunPort;
  signal: AbortSignal;
}

export interface ToolDef<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: Schema;
  /** Short label shown in the office and inspector ("src/app.ts", "npm test"). */
  summarize(input: z.infer<Schema>): string;
  run(input: z.infer<Schema>, context: ToolContext): Promise<string>;
}

function tool<Schema extends z.ZodType>(definition: ToolDef<Schema>): ToolDef<Schema> {
  return definition;
}

const pathField = z.string().max(500).describe('Path relative to the workspace root, using / separators');

const listFiles = tool({
  name: 'list_files',
  description: 'List files and folders in the workspace (recursive). Use before reading to see what exists.',
  schema: z.object({ path: pathField.optional() }),
  summarize: (input) => input.path || '.',
  async run(input, { run }) {
    const files = await run.workspace.listFiles(input.path || '.');
    return files.length ? files.join('\n') : '(empty)';
  },
});

const readFile = tool({
  name: 'read_file',
  description: 'Read a text file from the workspace.',
  schema: z.object({ path: pathField }),
  summarize: (input) => input.path,
  run: (input, { run }) => run.workspace.readFile(input.path),
});

const writeFile = tool({
  name: 'write_file',
  description: 'Create or overwrite a file in the workspace with the full new content. Folders are created as needed.',
  schema: z.object({ path: pathField, content: z.string().max(MAX_FILE_CHARS) }),
  summarize: (input) => input.path,
  async run(input, { run }) {
    const bytes = await run.workspace.writeFile(input.path, input.content);
    return `Wrote ${bytes} bytes to ${input.path}.`;
  },
});

const runCommand = tool({
  name: 'run_command',
  description:
    'Run a shell command in the workspace root (e.g. "npm test"). A human must approve every command, so run only what you need. Times out after 2 minutes.',
  // What you approve must be exactly what runs: no hidden lines, bidi overrides or zero-width tricks.
  schema: z.object({
    command: z.string().min(1).max(2_000).refine((command) => !HIDDEN_CHARACTERS.test(command), {
      message: 'Commands must be a single line of visible characters (no newlines, control, bidi or zero-width characters).',
    }),
  }),
  summarize: (input) => input.command,
  async run(input, { agentId, run, signal }) {
    const answer = await run.askHuman(agentId, `Run this command?\n${input.command}`, ['Approve', 'Deny'], 'approval');
    if (answer !== 'Approve') return `The human denied this command (answer: "${answer}"). Do not retry it; find another way or explain why it is needed.`;
    const result = await run.workspace.runCommand(input.command, signal);
    const status = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
    return `${status}\n${result.output || '(no output)'}`;
  },
});

const askHuman = tool({
  name: 'ask_human',
  description:
    'Ask the human a question and wait for the answer. Use only for decisions you cannot make yourself (requirements, preferences, approvals). Offer options when there are clear choices.',
  schema: z.object({
    question: z.string().min(1).max(2_000),
    options: z.array(z.string().min(1).max(100)).max(5).optional(),
  }),
  summarize: (input) => input.question,
  async run(input, { agentId, run }) {
    const options = input.options ?? [];
    const answer = await run.askHuman(agentId, input.question, options, options.length ? 'choice' : 'question');
    return `The human answered: ${answer}`;
  },
});

const askArchitect = tool({
  name: 'ask_architect',
  description: 'Ask the Architect a design question (APIs, structure, conventions) and wait for the answer.',
  schema: z.object({ question: z.string().min(1).max(2_000) }),
  summarize: (input) => input.question,
  run: (input, { agentId, run }) => run.askArchitect(agentId, input.question),
});

const createTasks = tool({
  name: 'create_tasks',
  description:
    'Split the work into tasks for the workers. Each task must be small and self-contained: one worker finishes it alone with the files in the workspace. Tasks in one call run in parallel, so they must not depend on each other.',
  schema: z.object({
    tasks: z.array(z.object({
      title: z.string().min(1).max(120).describe('Short imperative title, e.g. "Add todo storage module"'),
      details: z.string().max(4_000).describe('Exactly what to build, which files to touch, and how to know it is done'),
    })).min(1).max(8),
  }),
  summarize: (input) => `${input.tasks.length} task${input.tasks.length === 1 ? '' : 's'}`,
  run: async (input, { agentId, run }) => run.createTasks(agentId, input.tasks),
});

const writePlan = tool({
  name: 'write_plan',
  description: 'Publish the architecture plan on the whiteboard (markdown). This finishes your planning.',
  schema: z.object({ markdown: z.string().min(1).max(8_000) }),
  summarize: () => 'architecture plan',
  async run(input, { agentId, run }) {
    run.writePlan(agentId, input.markdown);
    return 'Plan published.';
  },
});

const answer = tool({
  name: 'answer',
  description: "Reply to a worker's question. Use only when a worker has asked you something.",
  schema: z.object({ answer: z.string().min(1).max(4_000) }),
  summarize: (input) => input.answer,
  async run(input, { agentId, run }) {
    run.answerQuestion(agentId, input.answer);
    return 'Answer sent.';
  },
});

const completeTask = tool({
  name: 'complete_task',
  description: 'Report that your task is finished (or that you could not finish it). This ends your work on the task.',
  schema: z.object({
    summary: z.string().min(1).max(2_000).describe('What you did, which files changed, anything left over'),
    success: z.boolean(),
  }),
  summarize: (input) => (input.success ? 'done' : 'gave up'),
  async run(input, { agentId, run }) {
    run.completeTask(agentId, input.summary, input.success);
    return 'Reported.';
  },
});

const finishRun = tool({
  name: 'finish_run',
  description: 'End the whole run with a short summary for the human of what was built.',
  schema: z.object({ summary: z.string().min(1).max(4_000) }),
  summarize: () => 'wrap up',
  async run(input, { agentId, run }) {
    run.finishRun(agentId, input.summary);
    return 'Run finished.';
  },
});

export const BOSS_TOOLS: readonly ToolDef[] = [createTasks, askHuman, finishRun];
export const ARCHITECT_TOOLS: readonly ToolDef[] = [listFiles, readFile, writePlan, askHuman, answer];
export const WORKER_TOOLS: readonly ToolDef[] = [listFiles, readFile, writeFile, runCommand, askArchitect, askHuman, completeTask];

/** The JSON-Schema form each provider sends to its model. */
export function toolSpecs(tools: readonly ToolDef[]): ToolSpec[] {
  return tools.map((definition) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(definition.schema) as Record<string, unknown>;
    return { name: definition.name, description: definition.description, inputSchema };
  });
}
