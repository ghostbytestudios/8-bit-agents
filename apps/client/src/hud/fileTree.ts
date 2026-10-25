/**
 * Turns the server's flat listing ("src/", "src/app.ts", "link (link)") into a tree for
 * the War Room's file cabinet: folders first, then files, each sorted by name.
 */

export interface TreeNode {
  name: string;
  /** Workspace-relative, without the trailing "/" for folders. */
  path: string;
  isFolder: boolean;
  isLink: boolean;
  children: TreeNode[];
}

const LINK_SUFFIX = ' (link)';

function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
  for (const node of nodes) sortTree(node.children);
  return nodes;
}

export function buildTree(entries: readonly string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();

  const folderAt = (path: string): TreeNode[] => {
    if (!path) return roots;
    const existing = folders.get(path);
    if (existing) return existing.children;
    const slash = path.lastIndexOf('/');
    const node: TreeNode = { name: path.slice(slash + 1), path, isFolder: true, isLink: false, children: [] };
    folders.set(path, node);
    folderAt(path.slice(0, Math.max(0, slash))).push(node);
    return node.children;
  };

  for (const entry of entries) {
    if (entry.endsWith('/')) {
      folderAt(entry.slice(0, -1));
      continue;
    }
    const isLink = entry.endsWith(LINK_SUFFIX);
    const path = isLink ? entry.slice(0, -LINK_SUFFIX.length) : entry;
    if (!path) continue;
    const slash = path.lastIndexOf('/');
    folderAt(path.slice(0, Math.max(0, slash))).push({ name: path.slice(slash + 1), path, isFolder: false, isLink, children: [] });
  }
  return sortTree(roots);
}

/** Every folder above `path`: "a/b/c.ts" → ["a", "a/b"]. */
export function parentFolders(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}
