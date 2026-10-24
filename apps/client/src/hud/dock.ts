import type { WorldState } from '../state/world';
import { ActivityLog } from './activityLog';
import { button, el } from './dom';
import { InboxPanel } from './inbox';
import { Inspector } from './inspector';
import { TaskBoard } from './taskBoard';

export type DockTab = 'inbox' | 'tasks' | 'log';

export interface DockHandlers {
  onRespond(requestId: string, answer: string): void;
  onSelectAgent(agentId: string): void;
  onCloseInspector(): void;
  onToggleFollow(): void;
}

interface Tab {
  button: HTMLButtonElement;
  panel: HTMLElement;
}

/** Right-hand column: the agent inspector on top, then INBOX / TASKS / LOG tabs. */
export class Dock {
  readonly inspector: Inspector;
  private readonly root = el('aside', 'dock');
  private readonly inbox: InboxPanel;
  private readonly tasks: TaskBoard;
  private readonly log = new ActivityLog();
  private readonly tabs = new Map<DockTab, Tab>();
  private readonly tabbed = el('section', 'panel tabbed');
  private active: DockTab = 'inbox';

  constructor(parent: HTMLElement, handlers: DockHandlers, isSimulated: boolean) {
    this.root.setAttribute('aria-label', 'Run panels');
    this.inspector = new Inspector({
      onClose: () => handlers.onCloseInspector(),
      onToggleFollow: () => handlers.onToggleFollow(),
      onOpenInbox: () => this.openTab('inbox', true),
    }, isSimulated);
    this.inbox = new InboxPanel({ onRespond: handlers.onRespond, onSelectAgent: handlers.onSelectAgent });
    this.tasks = new TaskBoard(handlers.onSelectAgent);

    const tabbed = this.tabbed;
    const tabList = el('div', 'tab-list');
    tabList.setAttribute('role', 'tablist');
    const tabBar = el('div', 'tab-bar');
    tabBar.append(tabList);
    tabbed.append(tabBar);
    const panels: Array<[DockTab, string, HTMLElement]> = [
      ['inbox', 'INBOX', this.inbox.element],
      ['tasks', 'TASKS', this.tasks.element],
      ['log', 'LOG', this.log.element],
    ];
    for (const [id, label, content] of panels) {
      const button = el('button', 'tab', label);
      button.type = 'button';
      button.id = `tab-${id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `panel-${id}`);
      button.addEventListener('click', () => this.openTab(id));
      const panel = el('div', 'tab-panel');
      panel.id = `panel-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.append(content);
      tabList.append(button);
      tabbed.append(panel);
      this.tabs.set(id, { button, panel });
    }
    const close = button('tab-close', '✕', () => this.closeTabs());
    close.setAttribute('aria-label', 'Close panel');
    close.title = 'Close (I, T or L reopens)';
    tabBar.append(close);
    this.root.append(this.inspector.element, tabbed);
    parent.append(this.root);
    this.openTab(this.active);
  }

  /**
   * Screen pixels the dock covers on the right edge (0 when hidden or when the
   * narrow-screen layout puts it along the bottom instead).
   */
  get coveredWidth(): number {
    if (!this.visible) return 0;
    const rect = this.root.getBoundingClientRect();
    return rect.left > window.innerWidth / 2 ? window.innerWidth - rect.left : 0;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  set visible(isVisible: boolean) {
    this.root.hidden = !isVisible;
  }

  openTab(tab: DockTab, shouldFocus = false): void {
    this.active = tab;
    this.visible = true;
    this.tabbed.hidden = false;
    for (const [id, { button, panel }] of this.tabs) {
      const isActive = id === tab;
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      panel.hidden = !isActive;
    }
    if (shouldFocus && tab === 'inbox') this.inbox.focusFirst();
  }

  /** Hides the INBOX / TASKS / LOG panel; the inspector (if open) stays. */
  closeTabs(): void {
    this.tabbed.hidden = true;
  }

  select(agentId: string | null): void {
    this.inspector.show(agentId);
    if (agentId) this.visible = true;
  }

  render(state: WorldState, now: number): void {
    this.inspector.render(state);
    this.inbox.render(state, now);
    this.tasks.render(state);
    this.log.render(state);
    const done = [...state.tasks.values()].filter((task) => task.state === 'done').length;
    this.label('inbox', state.inbox.size ? `INBOX ❗${state.inbox.size}` : 'INBOX', state.inbox.size > 0);
    this.label('tasks', `TASKS ${done}/${state.tasks.size}`, false);
  }

  private label(tab: DockTab, text: string, isUrgent: boolean): void {
    const button = this.tabs.get(tab)?.button;
    if (!button) return;
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('tab--urgent', isUrgent);
  }
}
