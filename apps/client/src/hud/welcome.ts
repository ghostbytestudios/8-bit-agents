import { APP_NAME } from '@harness/protocol';
import { button, el } from './dom';

/**
 * First-run welcome: connect a model, check the workspace folder, try a sample goal, or
 * just look around the demo office. Shown until a model is set up, unless closed.
 */

const DISMISSED_KEY = 'welcome-dismissed';

export interface WelcomeHandlers {
  onSetUpModels(): void;
  onChangeWorkspace(): void;
  onUseSampleGoal(): void;
  onTryDemo(): void;
}

/** Storage can be blocked; then the welcome simply shows again next time. */
function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Not remembered; harmless.
  }
}

function step(title: string, text: string, action: HTMLButtonElement, extra?: HTMLElement): HTMLElement {
  const card = el('section', 'settings-card welcome__step');
  card.append(el('h3', 'welcome__step-title', title), el('p', 'welcome__text', text));
  if (extra) card.append(extra);
  card.append(action);
  return card;
}

export class WelcomePanel {
  private readonly backdrop = el('div', 'settings-backdrop');
  private readonly dialog = el('section', 'panel settings welcome');
  private readonly workspace = el('code', 'welcome__path');
  private returnFocus: HTMLElement | null = null;

  constructor(parent: HTMLElement, handlers: WelcomeHandlers) {
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'welcome-title');
    this.dialog.tabIndex = -1;
    const title = el('h2', 'panel__title', `WELCOME TO ${APP_NAME.toUpperCase()}`);
    title.id = 'welcome-title';
    const close = button('pixel-button pixel-button--icon', '✕', () => this.dismiss());
    close.setAttribute('aria-label', 'Close welcome');
    const header = el('header', 'panel__header');
    header.append(title, close);

    // Each step hands off to the right place and gets out of the way.
    const go = (action: () => void) => () => {
      this.close();
      action();
    };
    const body = el('div', 'settings__body');
    body.append(
      el('p', 'welcome__text', 'Your team plans and builds whatever you ask, right here in the office. Three steps to the first run:'),
      step('1. CONNECT A MODEL', 'Paste an API key for Claude, OpenAI, OpenRouter or Groq, or use a free local model with Ollama or LM Studio.', button('pixel-button', 'SET UP MODELS', go(handlers.onSetUpModels))),
      step('2. CHECK THE WORKSPACE', 'Agents can only read and write inside this folder:', button('pixel-button', 'CHANGE FOLDER', go(handlers.onChangeWorkspace)), this.workspace),
      step('3. GIVE THEM A GOAL', 'Type a goal in the box at the top and press START, or begin with a small sample.', button('pixel-button', 'USE A SAMPLE GOAL', go(handlers.onUseSampleGoal))),
    );

    const footer = el('footer', 'settings__footer');
    footer.append(
      el('p', 'settings__notice', 'Just looking? The demo office runs with pretend agents, no key needed.'),
      button('pixel-button', 'TRY THE DEMO', () => {
        this.dismiss();
        handlers.onTryDemo();
      }),
      button('pixel-button', 'GOT IT', () => this.dismiss()),
    );

    this.dialog.append(header, body, footer);
    this.backdrop.append(this.dialog);
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.dismiss();
    });
    this.dialog.addEventListener('keydown', (event) => {
      event.stopPropagation(); // Office shortcuts stay off while the welcome is open.
      if (event.key === 'Escape') this.dismiss();
    });
    parent.append(this.backdrop);
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  /** Opens unless the user closed it before; returns whether it opened. */
  showIfNew(workspace: string): boolean {
    if (this.isOpen || readDismissed()) return false;
    this.workspace.textContent = workspace;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.backdrop.hidden = false;
    this.dialog.focus();
    return true;
  }

  close(): void {
    if (!this.isOpen) return;
    this.backdrop.hidden = true;
    this.returnFocus?.focus();
  }

  /** Closed on purpose: don't show it again. */
  private dismiss(): void {
    writeDismissed();
    this.close();
  }
}
