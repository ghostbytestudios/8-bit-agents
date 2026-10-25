import { MAX_TEXT, type HarnessEvent } from '@harness/protocol';
import { clip } from './agentLoop';
import type { RunHandle } from './hub';
import { Run } from './orchestrator';
import type { SettingsService } from './settings/service';
import type { SkillStore } from './skills';
import { Workspace } from './workspace';

export interface LiveRunDeps {
  settings: SettingsService;
  /** The War Room's skill shelf; each run takes the enabled skills as they are when it starts. */
  skills?: SkillStore;
  /** Env vars kept out of agent shells on top of the pattern-based scrub. */
  credentialNames: readonly string[];
  emit(event: HarnessEvent): void;
}

/**
 * A run built from the settings as they are when it starts — providers, keys, models,
 * names, limits and workspace — so changes in Settings apply from the next run.
 */
export class LiveRun implements RunHandle {
  private run: Run | null = null;
  private isStopped = false;

  constructor(private readonly deps: LiveRunDeps) {}

  async start(goal: string): Promise<void> {
    const { settings, skills, credentialNames, emit } = this.deps;
    let run: Run;
    try {
      const workspace = await Workspace.open(settings.settings.workspace, credentialNames);
      const shelf = (await skills?.list())?.filter((skill) => skill.enabled) ?? [];
      run = new Run({ config: settings.runConfig(), providers: settings.providers(), workspace, skills: shelf, emit });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'run.started', goal: clip(goal, MAX_TEXT) });
      emit({ type: 'run.finished', status: 'failed', summary: clip(`Couldn't start: ${message}`, MAX_TEXT) });
      return;
    }
    this.run = run;
    if (this.isStopped) run.stop();
    await run.start(goal);
  }

  stop(): void {
    this.isStopped = true;
    this.run?.stop();
  }

  respond(requestId: string, answer: string): boolean {
    return this.run?.respond(requestId, answer) ?? false;
  }
}
