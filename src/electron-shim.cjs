/**
 * CJS preload that mocks the 'electron' module for headless mode.
 * Load before the ESM entry point so top-level electron imports resolve.
 *
 * Usage: node --require ./src/electron-shim.cjs -e "..."
 *   or:  NODE_OPTIONS="--require ./src/electron-shim.cjs" npx tsx src/headless.ts
 */

const Module = require("module");
const originalResolve = Module._resolveFilename;

const home = process.env.HOME || "/root";
const dataDir = process.env.EXO_DATA_DIR || `${home}/.exo`;

const electronMock = {
  app: {
    getPath: (name) => {
      if (name === "userData") return dataDir;
      if (name === "temp") return "/tmp";
      return dataDir;
    },
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  shell: {
    openExternal: async (url) => {
      process.stderr.write(`[headless] Open this URL to authenticate: ${url}\n`);
    },
  },
  net: { fetch: globalThis.fetch },
  session: {},
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: class BrowserWindow {},
  utilityProcess: { fork() {} },
};

// Also mock @electron-toolkit/utils
const electronToolkitMock = {
  is: { dev: false },
  electronApp: {},
  optimizer: {},
};

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return "electron";
  if (request === "@electron-toolkit/utils") return "@electron-toolkit/utils";
  return originalResolve.call(this, request, parent, isMain, options);
};

const originalLoad = Module._cache;

// Inject into require cache
const electronModule = new Module("electron");
electronModule.exports = electronMock;
electronModule.loaded = true;
require.cache["electron"] = electronModule;

const toolkitModule = new Module("@electron-toolkit/utils");
toolkitModule.exports = electronToolkitMock;
toolkitModule.loaded = true;
require.cache["@electron-toolkit/utils"] = toolkitModule;
