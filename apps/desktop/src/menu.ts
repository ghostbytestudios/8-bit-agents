import { mkdir } from 'node:fs/promises';
import { APP_NAME } from '@harness/protocol';
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

const PROJECT_URL = 'https://github.com/ghostbytestudios/8-bit-agents';

export interface MenuActions {
  /** The agents' workspace folder, from Settings. */
  workspace(): string;
  dataDir: string;
  checkForUpdates(): void;
  log: Pick<Console, 'warn'>;
}

async function openFolder(folder: string, log: Pick<Console, 'warn'>): Promise<void> {
  await mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) log.warn(`[desktop] Couldn't open ${folder}: ${error}`);
}

/** Native menus; on macOS the first menu is the app menu. */
export function installMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';
  const folders: MenuItemConstructorOptions[] = [
    { label: 'Open Workspace Folder', click: () => void openFolder(actions.workspace(), actions.log) },
    { label: 'Open Settings Folder', click: () => void openFolder(actions.dataDir, actions.log) },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    { label: 'File', submenu: [...folders, { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    // Gives text fields copy / paste shortcuts on macOS.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates', enabled: app.isPackaged, click: () => actions.checkForUpdates() },
        { label: `${APP_NAME} on GitHub`, click: () => void shell.openExternal(PROJECT_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
