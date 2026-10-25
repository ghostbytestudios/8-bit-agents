import { contextBridge } from 'electron';

/** Set by the main process through `additionalArguments`; the page can't read argv itself. */
const SERVER_URL_ARG = '--harness-server-url=';

const serverUrl = process.argv.find((arg) => arg.startsWith(SERVER_URL_ARG))?.slice(SERVER_URL_ARG.length) ?? '';

// The whole bridge: one read-only string. The session token never reaches the page.
contextBridge.exposeInMainWorld('harnessDesktop', Object.freeze({ serverUrl }));
