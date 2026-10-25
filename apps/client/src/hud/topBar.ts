import { APP_NAME } from '@harness/protocol';
import type { WorldState } from '../state/world';
import type { ConnectionStatus } from '../net/socketFeed';
import { button, el } from './dom';
import { MAX_GOAL_CHARS, formatCost, normalizeGoal } from './format';

const NOTICE_MS = 6_000;
const RUN_LABEL = { running: 'RUNNING', done: 'DONE', stopped: 'STOPPED', failed: 'FAILED' } as const;
const CONNECTION_LABEL: Record<ConnectionStatus, string> = { connecting: 'CONNECTING…', live: '● LIVE', reconnecting: 'RECONNECTING…' };

export interface TopBarHandlers {
  onOpenInbox(): void;
  onOpenSettings(): void;
  onStart(goal: string): void;
  onStop(): void;
}

export interface TopBarMode {
  /** Events are invented by the in-browser mock. */
  isSimulated: boolean;
  /** The mock is running because no server answered. */
  isServerOffline: boolean;
  /** Embedded on the landing page. */
  isDemo?: boolean;
}

/**
 * Run status (exact, from the world store), the goal you gave the Boss, and the door to
 * the Boss's office: a goal box to start a run, or STOP while one is going.
 */
export class TopBar {
  private readonly status = el('span', 'topbar__status');
  private readonly connection = el('span', 'topbar__connection');
  private readonly alert: HTMLButtonElement;
  private readonly goal = el('p', 'topbar__goal');
  private readonly stop: HTMLButtonElement;
  private readonly form = el('form', 'topbar__form');
  private readonly input = el('input', 'pixel-input');
  private readonly notice = el('p', 'topbar__notice');
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;

  constructor(root: HTMLElement, handlers: TopBarHandlers, private readonly mode: TopBarMode) {
    const name = APP_NAME.toUpperCase();
    const mockTitle = mode.isDemo ? `${name} · DEMO` : `${name} · MOCK RUN${mode.isServerOffline ? ' (NO SERVER)' : ''}`;
    const title = mode.isSimulated ? mockTitle : name;
    this.alert = button('topbar__alert', '', handlers.onOpenInbox);
    this.stop = button('pixel-button pixel-button--danger', 'STOP', handlers.onStop);
    const settings = button('pixel-button topbar__settings', '⚙ SETTINGS', handlers.onOpenSettings);
    // The demo office has no server to save settings to.
    settings.hidden = mode.isSimulated;
    const line = el('div', 'topbar__line');
    line.append(el('span', 'topbar__title', title), this.connection, this.status, this.alert, settings);

    this.input.type = 'text';
    this.input.maxLength = MAX_GOAL_CHARS;
    this.input.placeholder = 'What should the team build?';
    this.input.setAttribute('aria-label', 'Goal for the team');
    const start = el('button', 'pixel-button', 'START');
    start.type = 'submit';
    this.form.append(this.input, start);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const goal = normalizeGoal(this.input.value);
      if (!goal) {
        this.input.focus();
        return;
      }
      handlers.onStart(goal);
    });

    const goalLine = el('div', 'topbar__line');
    goalLine.append(this.goal, this.stop);
    this.notice.setAttribute('role', 'status');
    root.append(line, goalLine, this.form, this.notice);
    // Correct before the first render: the mock never shows run controls.
    this.connection.hidden = mode.isSimulated;
    this.notice.hidden = true;
    this.goal.hidden = true;
    this.stop.hidden = true;
    this.form.hidden = mode.isSimulated;
  }

  setConnection(status: ConnectionStatus): void {
    this.isConnected = status === 'live';
    this.connection.textContent = CONNECTION_LABEL[status];
    this.connection.dataset.status = status;
  }

  showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice.hidden = true), NOTICE_MS);
  }

  /** Clears the goal box after the server accepted a new run. */
  clearGoal(): void {
    this.input.value = '';
  }

  render(state: WorldState): void {
    const { agents, tasks, inbox, totalCostUsd, run } = state;
    const done = [...tasks.values()].filter((task) => task.state === 'done').length;
    // The mock invents token usage; never let a fake number look like a real bill.
    this.status.textContent = `AGENTS ${agents.size} · TASKS ${done}/${tasks.size} · ${formatCost(totalCostUsd, this.mode.isSimulated)}`;
    this.alert.hidden = inbox.size === 0;
    this.alert.textContent = `❗ ${inbox.size} WAITING ON YOU`;

    const isRunning = run?.status === 'running';
    this.goal.hidden = !run;
    if (run) {
      const ending = run.status !== 'running' && run.summary ? ` — ${run.summary}` : '';
      this.goal.textContent = `🎯 ${run.goal} · ${RUN_LABEL[run.status]}${ending}`;
      this.goal.dataset.status = run.status;
    }
    this.stop.hidden = this.mode.isSimulated || !isRunning;
    this.form.hidden = this.mode.isSimulated || isRunning;
    this.form.classList.toggle('is-disabled', !this.isConnected);
  }
}
