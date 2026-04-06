/**
 * Registers module resolution hooks and polyfills for headless mode.
 *
 * - Redirects 'electron' and '@electron-toolkit/utils' to shims
 * - Polyfills import.meta.env (Vite build-time substitution)
 *
 * Must be loaded before the main entry via --import:
 *   npx tsx --import ./src/headless-register.ts src/headless.ts
 */
import { register } from "node:module";

// Polyfill import.meta.env for Vite-dependent code
// @ts-expect-error — import.meta.env doesn't exist outside Vite
if (!import.meta.env) {
  // @ts-expect-error — runtime polyfill
  import.meta.env = {
    ...process.env,
    MODE: "production",
    DEV: false,
    PROD: true,
  };
}

register("./headless-hooks.ts", import.meta.url);
