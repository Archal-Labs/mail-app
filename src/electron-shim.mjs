/**
 * ESM electron shim for headless mode.
 * Provides named exports matching Electron's public API.
 */

const home = process.env.HOME || "/root";
const dataDir = process.env.EXO_DATA_DIR || `${home}/.exo`;

export const app = {
  getPath: (name) => {
    if (name === "userData") return dataDir;
    if (name === "temp") return "/tmp";
    return dataDir;
  },
  getAppPath: () => process.cwd(),
  isPackaged: false,
};

export const shell = {
  openExternal: async (url) => {
    process.stderr.write(`[headless] Open to authenticate: ${url}\n`);
  },
};

export const net = { fetch: globalThis.fetch };
export const session = {};
export const ipcMain = { on() {}, handle() {} };
export class BrowserWindow {}
export const utilityProcess = { fork() {} };

// @electron-toolkit/utils exports
export const is = { dev: false };
export const electronApp = {};
export const optimizer = {};

export default {
  app, shell, net, session, ipcMain, BrowserWindow, utilityProcess,
  is, electronApp, optimizer,
};
