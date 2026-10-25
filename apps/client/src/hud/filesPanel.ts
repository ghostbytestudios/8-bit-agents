import type { HarnessCommand } from '@harness/protocol';
import type { LibraryReply } from '../net/socketFeed';
import { button, el, Region } from './dom';
import { buildTree, parentFolders, type TreeNode } from './fileTree';
import { Modal } from './modal';

/**
 * The War Room's file cabinet: the workspace's folders and files, and a read-only preview
 * of the one you pick. Files agents read or write during the run are marked with who.
 * Look, don't touch: editing while agents write the same files would only cause fights.
 */

export type TouchKind = 'read' | 'write';

type FilesReply = Extract<LibraryReply, { type: 'files' }>;
type FileReply = Extract<LibraryReply, { type: 'file' }>;

interface Touch {
  who: string;
  kind: TouchKind;
}

/** Writes come in bursts; one refresh after the burst is enough. */
const REFRESH_DELAY_MS = 1_200;
/** Small listings open fully; big ones start with only the top level open. */
const EXPAND_ALL_UNDER = 80;
const INDENT_PX = 12;

export interface FilesPanelHandlers {
  send(command: HarnessCommand): boolean;
}

/** Agent tools report paths as typed ("./src\\a.ts"); the listing uses "src/a.ts". */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

export class FilesPanel {
  private readonly modal: Modal;
  private readonly root = el('code', 'files__root');
  private readonly tree = new Region(el('div', 'files__tree'));
  private readonly previewPath = el('p', 'files__preview-path');
  private readonly previewText = el('pre', 'files__content', 'Pick a file to read it here.');
  private listing: FilesReply | null = null;
  private nodes: TreeNode[] = [];
  private readonly expanded = new Set<string>();
  private readonly touched = new Map<string, Touch>();
  private selected: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, private readonly handlers: FilesPanelHandlers) {
    this.modal = new Modal(parent, { id: 'files', title: 'FILES', className: 'files' });
    this.tree.element.setAttribute('role', 'tree');
    this.tree.element.setAttribute('aria-label', 'Workspace files');

    const top = el('div', 'files__top');
    top.append(this.root, button('pixel-button', 'REFRESH', () => this.refresh()));
    const preview = el('section', 'files__preview');
    preview.append(this.previewPath, this.previewText);
    const columns = el('div', 'files__columns');
    columns.append(this.tree.element, preview);
    this.modal.body.append(top, columns);
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  open(): void {
    this.modal.open();
    this.refresh();
  }

  close(): void {
    this.modal.close();
  }

  setListing(reply: FilesReply): void {
    const isNewRoot = this.listing?.root !== reply.root;
    this.listing = reply;
    this.nodes = buildTree(reply.entries);
    if (isNewRoot) {
      this.expanded.clear();
      for (const entry of reply.entries) {
        if (!entry.endsWith('/')) continue;
        const folder = entry.slice(0, -1);
        if (reply.entries.length < EXPAND_ALL_UNDER || !folder.includes('/')) this.expanded.add(folder);
      }
    }
    this.root.textContent = reply.root;
    this.root.title = reply.root;
    const count = reply.entries.filter((entry) => !entry.endsWith('/')).length;
    this.modal.showNotice(reply.truncated
      ? `Showing the first ${reply.entries.length.toLocaleString('en-US')} entries. node_modules and .git are skipped.`
      : `${count} file${count === 1 ? '' : 's'}. Read-only. Files agents read (👁) or wrote (✎) this run are marked.`);
    this.renderTree();
  }

  setFile(reply: FileReply): void {
    if (reply.path !== this.selected) return;
    this.previewPath.textContent = reply.path;
    this.previewText.textContent = reply.content || '(empty file)';
  }

  /** Called for agents' file tools as they happen. */
  markTouched(rawPath: string, who: string, kind: TouchKind): void {
    const path = normalizePath(rawPath);
    if (!path) return;
    // A read never hides an earlier write: the write is the more useful thing to know.
    if (kind === 'read' && this.touched.get(path)?.kind === 'write') return;
    this.touched.set(path, { who, kind });
    if (kind === 'write') {
      for (const folder of parentFolders(path)) this.expanded.add(folder);
      if (this.isOpen) this.scheduleRefresh();
    } else if (this.isOpen) this.renderTree();
  }

  /** A new run starts with a clean slate. */
  clearTouched(): void {
    this.touched.clear();
    this.renderTree();
  }

  showError(message: string): void {
    this.modal.showNotice(message, 'error');
  }

  private refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (!this.listing) this.modal.showNotice('Opening the cabinet…');
    if (!this.handlers.send({ type: 'files.list' })) {
      this.showError('Not connected to the server.');
      return;
    }
    if (this.selected) this.handlers.send({ type: 'file.read', path: this.selected });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
  }

  private select(path: string): void {
    this.selected = path;
    this.previewPath.textContent = path;
    this.previewText.textContent = 'Reading…';
    this.renderTree();
    if (!this.handlers.send({ type: 'file.read', path })) this.showError('Not connected to the server.');
  }

  private toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.renderTree();
  }

  private renderTree(): void {
    const signature = JSON.stringify([this.listing?.entries, [...this.expanded], [...this.touched], this.selected]);
    this.tree.render(signature, () => (this.nodes.length
      ? this.rows(this.nodes, 0)
      : [el('p', 'files__empty', this.listing ? 'The workspace is empty. Give the team a goal!' : '')]));
  }

  private rows(nodes: readonly TreeNode[], depth: number): HTMLElement[] {
    return nodes.flatMap((node) => {
      const row = this.row(node, depth);
      return node.isFolder && this.expanded.has(node.path) ? [row, ...this.rows(node.children, depth + 1)] : [row];
    });
  }

  private row(node: TreeNode, depth: number): HTMLElement {
    const isOpen = this.expanded.has(node.path);
    const label = node.isFolder ? `${isOpen ? '▾' : '▸'} ${node.name}/` : `${node.isLink ? '↪' : '·'} ${node.name}`;
    const item = button('files__item', label, () => (node.isFolder ? this.toggle(node.path) : this.select(node.path)));
    item.style.paddingLeft = `${6 + depth * INDENT_PX}px`;
    item.setAttribute('role', 'treeitem');
    if (node.isFolder) item.setAttribute('aria-expanded', String(isOpen));
    if (node.path === this.selected) item.setAttribute('aria-selected', 'true');
    if (node.isLink) {
      // Links may lead outside the workspace, so the cabinet won't open them.
      item.disabled = true;
      item.title = 'A link. The cabinet only opens files inside the workspace.';
    }
    const touch = this.touched.get(node.path);
    if (touch) item.append(el('span', `files__touch files__touch--${touch.kind}`, `${touch.kind === 'write' ? '✎' : '👁'} ${touch.who}`));
    return item;
  }
}
