import { describe, expect, it } from 'vitest';
import { demoEntries } from '../sim/mockLibrary';
import { buildTree, parentFolders, type TreeNode } from './fileTree';

const shape = (nodes: TreeNode[]): unknown[] =>
  nodes.map((node) => (node.isFolder ? { [node.name]: shape(node.children) } : node.isLink ? `${node.name} →` : node.name));

describe('buildTree', () => {
  it('nests files under their folders, folders first', () => {
    expect(shape(buildTree(['b.txt', 'src/', 'a.txt', 'src/z.ts', 'src/lib/', 'src/lib/x.ts']))).toEqual([
      { src: [{ lib: ['x.ts'] }, 'z.ts'] },
      'a.txt',
      'b.txt',
    ]);
  });

  it('creates folders the listing skipped, and marks links', () => {
    const tree = buildTree(['deep/er/file.md', 'shortcut (link)']);
    expect(shape(tree)).toEqual([{ deep: [{ er: ['file.md'] }] }, 'shortcut →']);
    expect(tree[0].children[0].path).toBe('deep/er');
    expect(tree[1].path).toBe('shortcut');
  });

  it('reads the demo workspace the same way as the server listing', () => {
    const entries = demoEntries();
    expect(entries.indexOf('src/')).toBeLessThan(entries.indexOf('src/server.ts'));
    expect(shape(buildTree(entries))[0]).toEqual({ docs: ['requirements.md'] });
  });
});

describe('parentFolders', () => {
  it('lists every folder above a path', () => {
    expect(parentFolders('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(parentFolders('top.md')).toEqual([]);
  });
});
