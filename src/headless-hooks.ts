/**
 * Node.js module resolution hooks for headless mode.
 * Redirects 'electron' and '@electron-toolkit/utils' to in-memory shims.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const SHIM_DIR = dirname(fileURLToPath(import.meta.url));
const ELECTRON_SHIM = pathToFileURL(join(SHIM_DIR, "electron-shim.mjs")).href;
const ENV_PRELUDE =
  `import.meta.env ??= ${JSON.stringify({
    ...process.env,
    MODE: "production",
    DEV: false,
    PROD: true,
  })};\n` +
  `import.meta.glob ??= (() => ({}));\n`;

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

export async function load(
  url: string,
  context: { format?: string | null },
  nextLoad: Function,
) {
  const result = await nextLoad(url, context);

  if (
    typeof result.source === "string" &&
    (result.format === "module" || context.format === "module") &&
    url.startsWith("file://") &&
    !url.endsWith("/electron-shim.mjs")
  ) {
    return {
      ...result,
      source: ENV_PRELUDE + result.source,
    };
  }

  return result;
}
