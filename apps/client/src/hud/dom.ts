/**
 * Small DOM builder for the HUD panels. Text always goes through textContent:
 * agent names, prompts and messages are untrusted and must never become markup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = el('button', className, text);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

/**
 * Rebuilds a container only when its content signature changes, so clicks on
 * elements inside aren't lost to a rebuild that lands between mousedown and mouseup.
 */
export class Region {
  private signature = '';

  constructor(readonly element: HTMLElement) {}

  render(signature: string, build: () => Node[]): void {
    if (signature === this.signature) return;
    this.signature = signature;
    this.element.replaceChildren(...build());
  }
}
