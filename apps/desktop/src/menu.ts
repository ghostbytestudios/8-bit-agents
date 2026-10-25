import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_NAME } from '@harness/protocol';
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

export const PROJECT_URL = 'https://github.com/ghostbytestudios/8-bit-agents';

export interface MenuActions {
  /** The agents' workspace folder, from Settings. */
  workspace(): string;
  dataDir: string;
  /** The app's local error log (Help › Open Error Log). */
  logFile: string;
  checkForUpdates(): void;
  showWhatsNew(): void;
  showAbout(): void;
  log: Pick<Console, 'warn'>;
}

async function openFolder(folder: string, log: Pick<Console, 'warn'>): Promise<void> {
  await mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) log.warn(`[desktop] Couldn't open ${folder}: ${error}`);
}

/** Opens the log in the system's text editor; an empty one is created if nothing was logged yet. */
async function openLogFile(file: string, log: Pick<Console, 'warn'>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, '', { mode: 0o600 });
  const error = await shell.openPath(file);
  if (error) log.warn(`[desktop] Couldn't open ${file}: ${error}`);
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
        { label: "What's New", click: () => actions.showWhatsNew() },
        { label: 'Check for Updates', enabled: app.isPackaged, click: () => actions.checkForUpdates() },
        { type: 'separator' },
        { label: 'Open Error Log', click: () => void openLogFile(actions.logFile, actions.log) },
        { label: 'Report a Problem', click: () => void shell.openExternal(`${PROJECT_URL}/issues`) },
        { label: `${APP_NAME} on GitHub`, click: () => void shell.openExternal(PROJECT_URL) },
        // On macOS "About" is in the app menu.
        ...(isMac ? [] : [{ type: 'separator' } as const, { label: `About ${APP_NAME}`, click: () => actions.showAbout() }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
