/**
 * Headless entry point for running the Exo mail agent without Electron.
 *
 * This boots the same agent-worker runtime used in production and drives it
 * through the worker/coordinator message boundary in-process. The only thing
 * stubbed is the Electron host environment.
 *
 * Usage:
 *   npx tsx src/headless.ts
 *   npx tsx src/headless.ts "Archive all newsletters"
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "./main/db";
import * as db from "./main/db";
import { GmailClient } from "./main/services/gmail-client";
import type {
  AgentFrameworkConfig,
  CoordinatorMessage,
  NetFetchResult,
  ScopedAgentEvent,
  WorkerMessage,
} from "./main/agents/types";
import type { AgentContext, AgentTaskState } from "./shared/agent-types";

class FakeMessagePort {
  constructor(private readonly onMessage: (event: ScopedAgentEvent) => void) {}

  postMessage(message: ScopedAgentEvent): void {
    this.onMessage(message);
  }

  start(): void {}

  close(): void {}
}

class FakeParentPort {
  private messageHandler: ((event: { data: WorkerMessage; ports?: FakeMessagePort[] }) => void) | null =
    null;

  constructor(private readonly onWorkerMessage: (message: CoordinatorMessage) => void) {}

  on(event: "message", handler: (event: { data: WorkerMessage; ports?: FakeMessagePort[] }) => void): void {
    if (event === "message") {
      this.messageHandler = handler;
    }
  }

  postMessage(message: CoordinatorMessage): void {
    this.onWorkerMessage(message);
  }

  dispatchToWorker(message: WorkerMessage, ports?: FakeMessagePort[]): void {
    this.messageHandler?.({ data: message, ports });
  }
}

type HeadlessProcess = NodeJS.Process & { parentPort?: FakeParentPort };

/** Create an isolated data dir with dummy OAuth creds so the Gmail client
 *  doesn't trigger an interactive browser flow. Sets EXO_DATA_DIR so the
 *  electron shim picks it up. Returns the temp dir path for cleanup. */
function initIsolatedDataDir(accountId: string): string {
  const dir = process.env["EXO_DATA_DIR"] || join(tmpdir(), `archal-exo-headless-${Date.now()}`);
  process.env["EXO_DATA_DIR"] = dir;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const credFile = join(dir, "credentials.json");
  if (!existsSync(credFile)) {
    writeFileSync(
      credFile,
      JSON.stringify({ client_id: "archal-headless", client_secret: "archal-headless" }),
    );
  }

  const tokFile =
    accountId === "default" ? join(dir, "tokens.json") : join(dir, `tokens-${accountId}.json`);
  writeFileSync(
    tokFile,
    JSON.stringify({
      access_token: "ya29.self-local-invalid",
      refresh_token: "archal-headless-proxy-refresh",
      token_type: "Bearer",
      expiry_date: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }),
  );

  return dir;
}

function cleanupOnExit(dir: string): void {
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function buildFrameworkConfig(): AgentFrameworkConfig {
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

  return {
    model: process.env["ARCHAL_ENGINE_MODEL"] ?? process.env["EXO_MODEL"] ?? "claude-sonnet-4-6",
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"] ?? process.env["EXO_API_KEY"],
    mcpServers,
  };
}

async function createCoordinatorBridge(): Promise<FakeParentPort> {
  initDatabase();

  const accountId = process.env["EXO_ACCOUNT_ID"] ?? "default";
  let gmailClient: GmailClient | null = null;

  try {
    gmailClient = new GmailClient(accountId);
    await gmailClient.connect();
    console.error("Gmail client connected");
  } catch (err) {
    console.error("Gmail connect failed:", err instanceof Error ? err.message : err);
  }

  const sendDbResponse = (requestId: string, result: unknown): void => {
    fakeParentPort.dispatchToWorker({ type: "db_response", requestId, result });
  };

  const sendDbError = (requestId: string, error: string): void => {
    fakeParentPort.dispatchToWorker({ type: "db_error", requestId, error });
  };

  const sendGmailResponse = (requestId: string, result: unknown): void => {
    fakeParentPort.dispatchToWorker({ type: "gmail_response", requestId, result });
  };

  const sendGmailError = (requestId: string, error: string): void => {
    fakeParentPort.dispatchToWorker({ type: "gmail_error", requestId, error });
  };

  const sendNetFetchResponse = (requestId: string, result: NetFetchResult): void => {
    fakeParentPort.dispatchToWorker({ type: "net_fetch_response", requestId, result });
  };

  const sendNetFetchError = (requestId: string, error: string): void => {
    fakeParentPort.dispatchToWorker({ type: "net_fetch_error", requestId, error });
  };

  const handleDbRequest = (requestId: string, method: string, args: unknown[]): void => {
    const fn = (db as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      sendDbError(requestId, `Unknown DB method: ${method}`);
      return;
    }

    try {
      const result = (fn as (...callArgs: unknown[]) => unknown)(...args);
      if (result instanceof Promise) {
        result.then((value) => sendDbResponse(requestId, value)).catch((err) => {
          sendDbError(requestId, err instanceof Error ? err.message : String(err));
        });
        return;
      }
      sendDbResponse(requestId, result);
    } catch (err) {
      sendDbError(requestId, err instanceof Error ? err.message : String(err));
    }
  };

  const fakeParentPort = new FakeParentPort((message) => {
    switch (message.type) {
      case "db_request":
        handleDbRequest(message.requestId, message.method, message.args);
        break;
      case "gmail_request":
        handleGmailRequest(message.requestId, message.method, message.args);
        break;
      case "net_fetch_request":
        void handleNetFetchRequest(message.requestId, message.url, message.options);
        break;
      case "confirmation_request":
        process.stderr.write(`[auto-approve] ${message.toolName}: ${message.description}\n`);
        fakeParentPort.dispatchToWorker({
          type: "confirm",
          toolCallId: message.toolCallId,
          approved: true,
        });
        break;
      case "providers_list":
      case "provider_loaded":
      case "provider_load_error":
      case "provider_health":
        break;
    }
  });

  const handleGmailRequest = (requestId: string, method: string, args: unknown[]): void => {
    if (!gmailClient) {
      sendGmailError(requestId, `Gmail method "${method}" called but Gmail client is unavailable.`);
      return;
    }

    try {
      const fn = (gmailClient as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        sendGmailError(requestId, `Unknown Gmail method: ${method}`);
        return;
      }
      const result = (fn as (...callArgs: unknown[]) => unknown).call(gmailClient, ...args);
      if (result instanceof Promise) {
        result.then((value) => sendGmailResponse(requestId, value)).catch((err) => {
          sendGmailError(requestId, err instanceof Error ? err.message : String(err));
        });
        return;
      }
      sendGmailResponse(requestId, result);
    } catch (err) {
      sendGmailError(requestId, err instanceof Error ? err.message : String(err));
    }
  };

  const handleNetFetchRequest = async (
    requestId: string,
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<void> => {
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      sendNetFetchResponse(requestId, { status: response.status, headers, body });
    } catch (err) {
      sendNetFetchError(requestId, err instanceof Error ? err.message : String(err));
    }
  };

  (process as HeadlessProcess).parentPort = fakeParentPort;
  return fakeParentPort;
}

function logEvent(event: ScopedAgentEvent): void {
  if (event.type === "text_delta") {
    process.stderr.write(event.text);
    return;
  }

  if (event.type === "error") {
    process.stderr.write(`\n[error] ${event.message}\n`);
    return;
  }

  if (event.type === "tool_call_start") {
    process.stderr.write(`\n[tool] ${event.toolName}\n`);
    return;
  }

  if (event.type === "tool_call_end") {
    process.stderr.write(`[tool_result] ${JSON.stringify(event.result)}\n`);
    return;
  }

  if (event.type === "state") {
    process.stderr.write(`\n[state] ${event.state}\n`);
  }
}

async function main(): Promise<void> {
  const accountId = process.env["EXO_ACCOUNT_ID"] ?? "default";
  const dataDir = initIsolatedDataDir(accountId);
  cleanupOnExit(dataDir);

  const fakeParentPort = await createCoordinatorBridge();
  await import("./main/agents/agent-worker");

  const config = buildFrameworkConfig();
  fakeParentPort.dispatchToWorker({ type: "init", config });

  if (process.env["ARCHAL_PREFLIGHT"] === "1") {
    console.error("Preflight: agent-worker boots OK");
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const task = process.argv[2]?.trim() || process.env["ARCHAL_ENGINE_TASK"]?.trim();
  if (!task) {
    console.error("No task provided. Pass as argument or set ARCHAL_ENGINE_TASK.");
    process.exit(1);
  }

  const taskId = randomUUID();
  const context: AgentContext = {
    accountId,
    userEmail: process.env["EXO_USER_EMAIL"] ?? "user@example.com",
    userName: process.env["EXO_USER_NAME"] ?? "User",
  };

  let finalState: Exclude<AgentTaskState, "running"> | null = null;
  let finalError: string | null = null;

  const completion = new Promise<void>((resolve) => {
    const port = new FakeMessagePort((event) => {
      logEvent(event);

      if (event.type === "error") {
        finalError = event.message;
      }

      if (
        event.type === "state" &&
        (event.state === "completed" || event.state === "failed" || event.state === "cancelled")
      ) {
        finalState = event.state;
        resolve();
      }
    });

    fakeParentPort.dispatchToWorker(
      {
        type: "run",
        taskId,
        providerIds: ["claude"],
        prompt: task,
        context,
      },
      [port],
    );
  });

  console.error(`Running task: ${task}`);
  await completion;

  if (finalState === "completed") {
    console.log(JSON.stringify({ status: "completed", taskId }));
    return;
  }

  console.log(
    JSON.stringify({
      status: finalState ?? "failed",
      taskId,
      ...(finalError ? { error: finalError } : {}),
    }),
  );
  process.exit(finalState === "cancelled" ? 130 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
