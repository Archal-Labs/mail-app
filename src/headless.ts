/**
 * Headless entry point for running the Exo mail agent without Electron.
 *
 * Reads the task from ARCHAL_ENGINE_TASK (or the first CLI argument),
 * initializes the database and Gmail client directly (no IPC), and runs
 * the AgentOrchestrator. All Electron dependencies are stubbed.
 *
 * Usage:
 *   npx tsx src/headless.ts                          # reads ARCHAL_ENGINE_TASK
 *   npx tsx src/headless.ts "Archive all newsletters" # inline task
 *
 * When run behind Archal's Docker proxy, all Gmail API calls to
 * gmail.googleapis.com are transparently redirected to the twin.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentOrchestrator } from "./main/agents/orchestrator";
import { initDatabase } from "./main/db";
import * as db from "./main/db";
import { GmailClient } from "./main/services/gmail-client";
import type {
  OrchestratorDeps,
  AgentFrameworkConfig,
  ScopedAgentEvent,
  ConfirmationDetails,
  NetFetchResult,
} from "./main/agents/types";
import type { AgentContext } from "./shared/agent-types";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create an isolated data dir with dummy OAuth creds so the Gmail client
 *  doesn't trigger an interactive browser flow. Sets EXO_DATA_DIR so the
 *  electron shim picks it up. Returns the temp dir path for cleanup. */
function initIsolatedDataDir(accountId: string): string {
  const dir = process.env["EXO_DATA_DIR"] || join(tmpdir(), `archal-exo-headless-${Date.now()}`);
  process.env["EXO_DATA_DIR"] = dir;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const credFile = join(dir, "credentials.json");
  if (!existsSync(credFile)) {
    writeFileSync(credFile, JSON.stringify({ client_id: "archal-headless", client_secret: "archal-headless" }));
  }

  const tokFile = accountId === "default" ? join(dir, "tokens.json") : join(dir, `tokens-${accountId}.json`);
  // Always write tokens to ensure a valid future expiry
  writeFileSync(tokFile, JSON.stringify({
    access_token: "ya29.self-local-invalid",
    refresh_token: "archal-headless-proxy-refresh",
    token_type: "Bearer",
    expiry_date: Date.now() + 365 * 24 * 60 * 60 * 1000,
  }));

  return dir;
}

/** Best-effort cleanup of the isolated data dir on exit. */
function cleanupOnExit(dir: string): void {
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

/** Create a typed proxy that forwards method calls to a module/instance. */
function makeProxy<T extends Record<string, unknown>>(
  target: T | null,
  label: string,
): (method: string, ...args: unknown[]) => unknown {
  return (method: string, ...args: unknown[]) => {
    if (!target) throw new Error(`${label} method "${method}" called but no ${label} available.`);
    const fn = target[method];
    if (typeof fn !== "function") throw new Error(`Unknown ${label} method: ${method}`);
    return (fn as (...a: unknown[]) => unknown).call(target, ...args);
  };
}

async function main(): Promise<void> {
  // ── Preflight check ─────────────────────────────────────────────────
  // Archal runs a preflight boot check before provisioning twins.
  // When ARCHAL_PREFLIGHT=1, just verify the process can start and exit 0.
  if (process.env["ARCHAL_PREFLIGHT"] === "1") {
    console.error("Preflight: headless agent boots OK");
    // Use setTimeout to let pino's sonic-boom flush before exit
    setTimeout(() => process.exit(0), 50);
    return;
  }

  // ── Read task ───────────────────────────────────────────────────────

  const task =
    process.argv[2]?.trim() ||
    process.env["ARCHAL_ENGINE_TASK"]?.trim();

  if (!task) {
    console.error(
      "No task provided. Pass as argument or set ARCHAL_ENGINE_TASK.",
    );
    process.exit(1);
  }

  // ── Isolated data dir ───────────────────────────────────────────────
  // Write dummy OAuth credentials to a temp dir instead of ~/.exo so we
  // never corrupt the user's real Exo credentials.

  const accountId = process.env["EXO_ACCOUNT_ID"] ?? "default";
  const dataDir = initIsolatedDataDir(accountId);
  cleanupOnExit(dataDir);

  // ── Initialize database ─────────────────────────────────────────────

  initDatabase();

  const dbProxy: OrchestratorDeps["dbProxy"] = makeProxy(
    db as unknown as Record<string, unknown>, "db",
  ) as OrchestratorDeps["dbProxy"];

  // ── Initialize Gmail client ─────────────────────────────────────────

  let gmailClient: GmailClient | null = null;

  try {
    gmailClient = new GmailClient(accountId);
    await gmailClient.connect();
    console.error("Gmail client connected");
  } catch (err) {
    console.error("Gmail connect failed:", err instanceof Error ? err.message : err);
    gmailClient = null;
  }

  const gmailProxy: OrchestratorDeps["gmailProxy"] = async (
    method: string,
    _accountId: string,
    ...args: unknown[]
  ) => {
    const proxy = makeProxy(gmailClient as unknown as Record<string, unknown> | null, "Gmail");
    return proxy(method, ...args);
  };

  // ── Net fetch proxy ─────────────────────────────────────────────────

  const netFetchProxy: OrchestratorDeps["netFetchProxy"] = async (
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<NetFetchResult> => {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, body };
  };

  // ── Stub Electron dependencies ──────────────────────────────────────

  const emitToRenderer = (_taskId: string, event: ScopedAgentEvent): void => {
    if (event.type === "message") {
      const text =
        typeof event.data === "string"
          ? event.data
          : JSON.stringify(event.data);
      process.stderr.write(`[agent] ${text}\n`);
    } else if (event.type === "state") {
      process.stderr.write(`[state] ${String((event as { state: string }).state)}\n`);
    } else if (event.type === "tool_use") {
      process.stderr.write(`[tool] ${String((event as { toolName: string }).toolName)}\n`);
    }
  };

  const requestConfirmation = (details: ConfirmationDetails): void => {
    // Auto-approve all tool calls in headless mode
    process.stderr.write(
      `[auto-approve] ${details.toolName}: ${details.description}\n`,
    );
  };

  // ── Build config ────────────────────────────────────────────────────

  // If archal provided MCP server config, include it so the agent
  // can use twin tools alongside its built-in email tools.
  let mcpServers: AgentFrameworkConfig["mcpServers"] | undefined;
  const mcpConfigPath = process.env["ARCHAL_MCP_CONFIG"]?.trim();
  if (mcpConfigPath) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      if (mcpConfig?.mcpServers && typeof mcpConfig.mcpServers === "object") {
        mcpServers = mcpConfig.mcpServers;
        console.error(`Loaded ${Object.keys(mcpServers).length} MCP server(s) from archal config`);
      }
    } catch (err) {
      console.error("Failed to load MCP config:", err instanceof Error ? err.message : err);
    }
  }

  const config: AgentFrameworkConfig = {
    model:
      process.env["ARCHAL_ENGINE_MODEL"] ??
      process.env["EXO_MODEL"] ??
      "claude-sonnet-4-6",
    anthropicApiKey:
      process.env["ANTHROPIC_API_KEY"] ?? process.env["EXO_API_KEY"],
    mcpServers,
  };

  // ── Build orchestrator deps ─────────────────────────────────────────

  const deps: OrchestratorDeps = {
    emitToRenderer,
    requestConfirmation,
    dbProxy,
    gmailProxy,
    netFetchProxy,
    config,
    setActiveTaskId: () => {},
  };

  // ── Run ─────────────────────────────────────────────────────────────

  const orchestrator = new AgentOrchestrator(deps);

  const taskId = randomUUID();
  const context: AgentContext = {
    accountId,
    userEmail: process.env["EXO_USER_EMAIL"] ?? "user@example.com",
    userName: process.env["EXO_USER_NAME"] ?? "User",
  };

  console.error(`Running task: ${task}`);

  try {
    await orchestrator.runCommand(taskId, ["claude"], task, context);
    console.log(JSON.stringify({ status: "completed", taskId }));
  } catch (err) {
    console.error("Agent failed:", err);
    console.log(
      JSON.stringify({
        status: "failed",
        taskId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
