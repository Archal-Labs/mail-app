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

  // ── Initialize database ─────────────────────────────────────────────

  initDatabase();

  // Direct db proxy — calls db module functions without IPC
  const dbProxy: OrchestratorDeps["dbProxy"] = async (
    method: string,
    ...args: unknown[]
  ) => {
    const dbModule = db as Record<string, (...a: unknown[]) => unknown>;
    const fn = dbModule[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown db method: ${method}`);
    }
    return fn(...args);
  };

  // ── Initialize Gmail client ─────────────────────────────────────────

  const accountId = process.env["EXO_ACCOUNT_ID"] ?? "default";
  let gmailClient: GmailClient | null = null;

  // Ensure dummy OAuth credentials + tokens exist so the Gmail client
  // doesn't trigger an interactive browser OAuth flow. When running behind
  // Archal's TLS proxy, all gmail.googleapis.com calls route to the twin
  // which doesn't check OAuth — the token values are irrelevant.
  {
    const { writeFileSync: _wfs, existsSync: _exists, mkdirSync: _mkdir } = await import("fs");
    const { join: _join } = await import("path");
    const { homedir: _home } = await import("os");
    const _dir = _join(_home(), ".exo");
    const _cred = _join(_dir, "credentials.json");
    const _tok = accountId === "default" ? _join(_dir, "tokens.json") : _join(_dir, `tokens-${accountId}.json`);
    if (!_exists(_dir)) _mkdir(_dir, { recursive: true });
    if (!_exists(_cred)) {
      _wfs(_cred, JSON.stringify({ client_id: "archal-headless", client_secret: "archal-headless" }));
    }
    // Always write tokens to ensure a valid future expiry
    _wfs(_tok, JSON.stringify({
      access_token: "ya29.self-local-invalid",
      refresh_token: "archal-headless-proxy-refresh",
      token_type: "Bearer",
      expiry_date: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }));
  }

  try {
    gmailClient = new GmailClient(accountId);
    await gmailClient.connect();
    console.error("Gmail client connected");
  } catch (err) {
    console.error("Gmail connect failed:", err instanceof Error ? err.message : err);
    gmailClient = null;
  }

  // Direct gmail proxy — calls GmailClient methods without IPC.
  // When gmailClient is null (no credentials, running against twins),
  // we still try to use it — tools may not call gmail methods at all
  // if the twin provides MCP tools directly.
  const gmailProxy: OrchestratorDeps["gmailProxy"] = async (
    method: string,
    _accountId: string,
    ...args: unknown[]
  ) => {
    if (!gmailClient) {
      throw new Error(
        `Gmail method "${method}" called but no Gmail client available. ` +
        `Ensure OAuth credentials exist or run against an Archal twin.`,
      );
    }
    const fn = (gmailClient as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown Gmail method: ${method}`);
    }
    // Bind to gmailClient so `this` is correct inside the method
    return (fn as (...a: unknown[]) => unknown).call(gmailClient, ...args);
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
      const { readFileSync: readMcp } = await import("fs");
      const mcpConfig = JSON.parse(readMcp(mcpConfigPath, "utf-8"));
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
