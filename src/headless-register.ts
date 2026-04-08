/**
 * Registers module resolution hooks and runtime shims for headless mode.
 *
 * Must be loaded before the main entry via --import:
 *   npx tsx --import ./src/headless-register.ts src/headless.ts
 */
import { createRequire, register } from "node:module";

const globalRequire = createRequire(import.meta.url);
if (!("require" in globalThis)) {
  // @ts-expect-error - headless-only CommonJS compatibility for ESM modules
  globalThis.require = globalRequire;
}

register("./headless-hooks.ts", import.meta.url);
