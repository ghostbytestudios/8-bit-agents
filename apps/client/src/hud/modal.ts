import { button, el } from './dom';

/**
 * A dimmed dialog in the Settings style, used by the War Room's file cabinet and skill
 * shelf: a header with a close button, a body, and a footer with a notice line.
 */

export interface ModalOptions {
  id: string;
  title: string;
  className: string;
  /** Asked before closing; return false to stay open (e.g. unsaved edits). */
  canClose?: () => boolean;
}

export class Modal {
  readonly body = el('div', 'settings__body');
  readonly footer = el('footer', 'settings__footer');
  readonly notice = el('p', 'settings__notice');
  private readonly backdrop = el('div', 'settings-backdrop');
  private readonly dialog: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly options: ModalOptions) {
    this.dialog = el('section', `panel settings ${options.className}`);
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', `${options.id}-title`);
    this.dialog.tabIndex = -1;
    const title = el('h2', 'panel__title', options.title);
    title.id = `${options.id}-title`;
    const close = button('pixel-button pixel-button--icon', '✕', () => this.close());
    close.setAttribute('aria-label', `Close ${options.title.toLowerCase()}`);
    const header = el('header', 'panel__header');
    header.append(title, close);
    this.footer.append(this.notice);

    this.dialog.append(header, this.body, this.footer);
    this.backdrop.append(this.dialog);
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    this.dialog.addEventListener('keydown', (event) => {
      event.stopPropagation(); // Office shortcuts stay off while the dialog is open.
      if (event.key === 'Escape') this.close();
    });
    parent.append(this.backdrop);
  }

  get isOpen(): boolean {
    return !this.backdrop.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.backdrop.hidden = false;
    this.dialog.focus();
  }

  close(): void {
    if (!this.isOpen || this.options.canClose?.() === false) return;
    this.backdrop.hidden = true;
    this.returnFocus?.focus();
  }

  showNotice(text: string, kind: 'error' | 'ok' | 'info' = 'info'): void {
    this.notice.textContent = text;
    this.notice.dataset.kind = kind;
  }
}
