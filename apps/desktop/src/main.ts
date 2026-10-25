import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_NAME } from '@harness/protocol';
import {
  adoptLegacyDataDir,
  appDataDir,
  defaultSettings,
  defaultWorkspace,
  FileSecretStore,
  HARNESS_HOST,
  legacyAppDataDir,
  startHarness,
  TOKEN_HEADER,
  type RunningHarness,
  type SecretStore,
} from '@harness/server/app';
import { app, BrowserWindow, crashReporter, dialog, protocol, safeStorage, screen, session, shell, type WebContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import { APP_ORIGIN, APP_SCHEME, contentSecurityPolicy, contentTypeOf, isSafeExternalUrl, resolveAppFile } from './appFiles';
import { ErrorLog, teeLogger } from './errorLog';
import { installMenu, PROJECT_URL } from './menu';
import { EncryptedSecretStore } from './secretStore';
import { CHANGELOG, formatNotes, notesFor, takeUnseenNotes, type ReleaseNotes } from './whatsNew';
import { initialBounds, loadWindowState, MIN_WINDOW, saveWindowState } from './windowState';

/** The built client and the preload script sit next to this file in the bundle. */
const RENDERER_DIR = path.join(__dirname, 'renderer');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
/** Matches the HUD's --ink, so the window doesn't flash white while loading. */
const BACKGROUND = '#181425';
/** For automated checks: open, wait, save a screenshot here, print the top bar, quit. */
const SMOKE_SCREENSHOT = process.env.HARNESS_SMOKE_SCREENSHOT;
const SMOKE_SETTLE_MS = 6_000;

// The same folder the dev server uses (HARNESS_DATA_DIR overrides it); must be set before `ready`.
const DATA_DIR = path.resolve(appDataDir());
if (!process.env.HARNESS_DATA_DIR) adoptLegacyDataDir(DATA_DIR, legacyAppDataDir());
app.setPath('userData', DATA_DIR);
app.setName(APP_NAME);

/** Startup, warnings, errors and crashes; Help › Open Error Log. Stays on this computer. */
const LOG_FILE = path.join(DATA_DIR, 'logs', 'main.log');
const log = teeLogger(console, new ErrorLog(LOG_FILE));
// Native crash dumps are kept locally too; nothing is ever uploaded.
app.setPath('crashDumps', path.join(DATA_DIR, 'crashes'));
crashReporter.start({ uploadToServer: false });

// A standard, secure scheme gives the page a real origin (app://harness) for the server's origin check.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;
let harness: RunningHarness | null = null;
/** Finished before the process exits, so the file is never left half-written. */
let pendingWindowSave: Promise<void> = Promise.resolve();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The OS keychain when there is one; Linux without a keyring falls back to a 0600 file. */
async function openSecretStore(dataDir: string): Promise<SecretStore> {
  const hasKeyring = process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  if (safeStorage.isEncryptionAvailable() && hasKeyring) return EncryptedSecretStore.open(dataDir, safeStorage, log);
  log.warn('[desktop] No OS keychain available; API keys are kept in a file only your account can read.');
  return FileSecretStore.open(dataDir, log);
}

async function serveAppFile(request: Request, serverPort: number): Promise<Response> {
  const file = request.method === 'GET' ? resolveAppFile(RENDERER_DIR, request.url) : null;
  const body = file ? await readFile(file).catch(() => null) : null;
  if (!file || !body) return new Response('Not found', { status: 404 });
  return new Response(body, {
    headers: {
      'content-type': contentTypeOf(file),
      'content-security-policy': contentSecurityPolicy(serverPort),
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The window may reach its own bundle and the local server, nothing else. */
function lockDownSession(serverPort: number, sessionToken: string): void {
  const serverPrefix = `ws://${HARNESS_HOST}:${serverPort}/`;
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith(serverPrefix) });
  });
  // The token is added to the socket handshake here, so the page never holds it.
  ses.webRequest.onBeforeSendHeaders({ urls: [`${serverPrefix}*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: sessionToken } });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  protocol.handle(APP_SCHEME, (request) => serveAppFile(request, serverPort));
}

/** Applies to every page Electron creates: no new windows, no navigation away, no webviews. */
function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    // "GET A KEY" and similar links open in the system browser.
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const stayInApp = (event: { preventDefault(): void }, url: string) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  };
  contents.on('will-navigate', (event, url) => stayInApp(event, url));
  contents.on('will-redirect', (event, url) => stayInApp(event, url));
  contents.on('will-frame-navigate', (details) => stayInApp(details, details.url));
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow(serverPort: number, dataDir: string): Promise<BrowserWindow> {
  const saved = await loadWindowState(dataDir);
  const window = new BrowserWindow({
    ...initialBounds(saved, screen.getAllDisplays().map((display) => display.workArea)),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: APP_NAME,
    backgroundColor: BACKGROUND,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      additionalArguments: [`--harness-server-url=ws://${HARNESS_HOST}:${serverPort}/ws`],
    },
  });
  if (saved?.isMaximized) window.maximize();
  // Page errors go to the error log; warnings only while developing.
  const logsPageWarnings = !app.isPackaged || Boolean(SMOKE_SCREENSHOT);
  window.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') log.error(`[page] ${message}`);
    else if (level === 'warning' && logsPageWarnings) log.warn(`[page] ${message}`);
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', () => {
    const state = { ...window.getNormalBounds(), isMaximized: window.isMaximized() };
    pendingWindowSave = saveWindowState(dataDir, state).catch((error: unknown) => log.warn(`[desktop] Couldn't save window position: ${errorMessage(error)}`));
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(`${APP_ORIGIN}/`);
  return window;
}

function checkForUpdates(): void {
  if (!app.isPackaged || process.env.HARNESS_NO_UPDATES) return;
  autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => log.warn(`[desktop] Update check failed: ${errorMessage(error)}`));
}

function showNotes(title: string, releases: readonly ReleaseNotes[]): void {
  const options = { type: 'info' as const, title, message: title, detail: formatNotes(releases), buttons: ['OK'] };
  const shown = mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  shown.catch((error: unknown) => log.warn(`[desktop] ${errorMessage(error)}`));
}

function showWhatsNew(): void {
  const notes = notesFor(CHANGELOG, app.getVersion());
  showNotes(`What's new in ${APP_NAME}`, notes ? [notes] : []);
}

function showAbout(): void {
  const options = {
    type: 'info' as const,
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [`Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`, '© 2026 Ghostbyte Studios', PROJECT_URL].join('\n'),
    buttons: ['OK'],
  };
  const shown = mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  shown.catch((error: unknown) => log.warn(`[desktop] ${errorMessage(error)}`));
}

/** After an update, once: what changed since the version that ran last. */
async function showUnseenNotes(dataDir: string): Promise<void> {
  const unseen = await takeUnseenNotes(dataDir, app.getVersion());
  if (unseen.length > 0) showNotes(`${APP_NAME} was updated`, unseen);
}

async function smokeTest(window: BrowserWindow, screenshotPath: string): Promise<void> {
  await delay(SMOKE_SETTLE_MS);
  const topBar: unknown = await window.webContents.executeJavaScript("document.getElementById('topbar')?.innerText ?? ''");
  log.info(`[smoke] top bar: ${String(topBar).replace(/\s+/g, ' ').trim()}`);
  await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
  log.info(`[smoke] screenshot: ${screenshotPath}`);
  app.quit();
}

async function start(): Promise<void> {
  const dataDir = app.getPath('userData');
  const sessionToken = randomBytes(32).toString('hex');
  harness = await startHarness({
    dataDir,
    port: 0,
    allowedOrigins: [APP_ORIGIN],
    sessionToken,
    initialSettings: () => defaultSettings(defaultWorkspace()),
    protectedFolders: [os.homedir(), dataDir, app.getAppPath(), path.dirname(app.getPath('exe'))],
    secrets: await openSecretStore(dataDir),
    log,
  });
  lockDownSession(harness.port, sessionToken);
  const { settings } = harness;
  installMenu({ workspace: () => settings.settings.workspace, dataDir, logFile: LOG_FILE, checkForUpdates, showWhatsNew, showAbout, log });
  mainWindow = await createWindow(harness.port, dataDir);
  log.info(`[desktop] ${APP_NAME} ${app.getVersion()} ready; settings in ${dataDir}`);

  if (SMOKE_SCREENSHOT) {
    await smokeTest(mainWindow, path.resolve(SMOKE_SCREENSHOT));
    return;
  }
  checkForUpdates();
  showUnseenNotes(dataDir).catch((error: unknown) => log.warn(`[desktop] Couldn't read the last version: ${errorMessage(error)}`));
}

function fail(error: unknown): void {
  log.error(error);
  dialog.showErrorBox(`${APP_NAME} couldn't start`, errorMessage(error));
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; it brings its window forward.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('web-contents-created', (_event, contents) => hardenContents(contents));
  // Crashes land in the error log, so there's something to attach to a bug report.
  process.on('uncaughtException', (error) => log.error('[desktop] Uncaught error:', error));
  process.on('unhandledRejection', (reason) => log.error('[desktop] Unhandled rejection:', reason));
  app.on('render-process-gone', (_event, _contents, details) => log.error(`[desktop] The window crashed: ${details.reason} (exit code ${details.exitCode})`));
  app.on('child-process-gone', (_event, details) => log.error(`[desktop] ${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`));
  // On macOS apps stay open without windows; the dock icon brings one back.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow && harness) createWindow(harness.port, app.getPath('userData')).then((window) => (mainWindow = window), fail);
  });
  // Stop any run and close the server before the process exits.
  app.on('will-quit', (event) => {
    const running = harness;
    if (!running) return;
    harness = null;
    event.preventDefault();
    Promise.all([running.close(), pendingWindowSave])
      .catch((error: unknown) => log.warn(`[desktop] ${errorMessage(error)}`))
      .finally(() => app.quit());
  });
  app.whenReady().then(start).catch(fail);
}
