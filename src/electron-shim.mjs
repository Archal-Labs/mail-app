/**
 * ESM electron shim for headless mode.
 * Provides named exports matching Electron's public API.
 *
 * MAINTENANCE: When the upstream app adds new Electron imports (e.g.
 * `import { clipboard } from "electron"`), a matching stub must be added
 * here — otherwise headless mode will crash with an unresolved export.
 */

/** Resolve the data directory lazily so EXO_DATA_DIR can be set after import. */
function getDataDir() {
  const home = process.env.HOME || "/root";
  return process.env.EXO_DATA_DIR || `${home}/.exo`;
}

export const app = {
  getPath: (name) => {
    if (name === "userData") return getDataDir();
    if (name === "temp") return "/tmp";
    return getDataDir();
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

// Common Electron APIs that upstream might import in the future.
// Stubbed proactively to avoid headless crashes.
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {},
};
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };
export const Tray = class Tray { constructor() {} setContextMenu() {} setToolTip() {} };
export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" };

// @electron-toolkit/utils exports
export const is = { dev: false };
export const electronApp = {};
export const optimizer = {};

export default {
  app, shell, net, session, ipcMain, BrowserWindow, utilityProcess,
  dialog, Menu, Tray, nativeTheme,
  is, electronApp, optimizer,
};
