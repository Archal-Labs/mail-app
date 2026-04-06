/**
 * Node.js module resolution hooks for headless mode.
 * Redirects 'electron' and '@electron-toolkit/utils' to in-memory shims.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const SHIM_DIR = dirname(fileURLToPath(import.meta.url));
const ELECTRON_SHIM = pathToFileURL(join(SHIM_DIR, "electron-shim.mjs")).href;

export function resolve(
  specifier: string,
  context: { parentURL?: string; conditions: string[] },
  nextResolve: Function,
) {
  if (specifier === "electron" || specifier === "@electron-toolkit/utils") {
    return { url: ELECTRON_SHIM, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
