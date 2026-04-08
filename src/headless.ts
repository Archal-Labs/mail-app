/**
 * Headless entry point for running the Exo mail agent without Electron.
 *
 * This boots the same agent-worker runtime used in production and drives it
 * through the worker/coordinator message boundary in-process. The only thing
 * stubbed is the Electron host environment.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type TerminalState = Exclude<AgentTaskState, "running">;
type WorkerEvent = { data: WorkerMessage; ports?: FakeMessagePort[] };
type FakeMessagePort = {
  postMessage(message: ScopedAgentEvent): void;
  start(): void;
  close(): void;
};
type FakeParentPort = {
  on(event: "message", handler: (event: WorkerEvent) => void): void;
  postMessage(message: CoordinatorMessage): void;
  dispatch(message: WorkerMessage, ports?: FakeMessagePort[]): void;
};
type HeadlessProcess = NodeJS.Process & { parentPort?: FakeParentPort };
type HeadlessDir = { path: string; owned: boolean };

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createFakeMessagePort(onMessage: (event: ScopedAgentEvent) => void): FakeMessagePort {
  return {
    postMessage: onMessage,
    start() {},
    close() {},
  };
}

function createFakeParentPort(onWorkerMessage: (message: CoordinatorMessage) => void): FakeParentPort {
  let messageHandler: ((event: WorkerEvent) => void) | null = null;

  return {
    on(event, handler) {
      if (event === "message") {
        messageHandler = handler;
      }
    },
    postMessage(message) {
      onWorkerMessage(message);
    },
    dispatch(message, ports) {
      messageHandler?.({ data: message, ports });
    },
  };
}

function ensureHeadlessDataDir(accountId: string): HeadlessDir {
  const existingDir = process.env["EXO_DATA_DIR"]?.trim();
  const dir = existingDir || join(tmpdir(), `archal-exo-headless-${Date.now()}`);
  process.env["EXO_DATA_DIR"] = dir;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const credentialsPath = join(dir, "credentials.json");
  if (!existsSync(credentialsPath)) {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ client_id: "archal-headless", client_secret: "archal-headless" }),
    );
  }

  const tokenPath =
    accountId === "default" ? join(dir, "tokens.json") : join(dir, `tokens-${accountId}.json`);
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: "ya29.self-local-invalid",
      refresh_token: "archal-headless-proxy-refresh",
      token_type: "Bearer",
      expiry_date: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }),
  );

  return { path: dir, owned: !existingDir };
}

function installCleanup(dataDir: HeadlessDir): void {
  if (!dataDir.owned) {
    return;
  }

  const cleanup = () => {
    try {
      rmSync(dataDir.path, { recursive: true, force: true });
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

function loadMcpServers(): AgentFrameworkConfig["mcpServers"] | undefined {
  const mcpConfigPath = process.env["ARCHAL_MCP_CONFIG"]?.trim();
  if (!mcpConfigPath) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
      console.error(`Loaded ${Object.keys(parsed.mcpServers).length} MCP server(s) from archal config`);
      return parsed.mcpServers;
    }
  } catch (err) {
    console.error("Failed to load MCP config:", formatError(err));
  }

  return undefined;
}

function buildFrameworkConfig(): AgentFrameworkConfig {
  return {
    model: process.env["ARCHAL_ENGINE_MODEL"] ?? process.env["EXO_MODEL"] ?? "claude-sonnet-4-6",
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"] ?? process.env["EXO_API_KEY"],
    mcpServers: loadMcpServers(),
  };
}

async function invokeMethod(
  target: Record<string, unknown> | null,
  label: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!target) {
    throw new Error(`${label} method "${method}" called but ${label} is unavailable.`);
  }

  const fn = target[method];
  if (typeof fn !== "function") {
    throw new Error(`Unknown ${label} method: ${method}`);
  }

  return await (fn as (...callArgs: unknown[]) => unknown).call(target, ...args);
}

function logEvent(event: ScopedAgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stderr.write(event.text);
      return;
    case "error":
      process.stderr.write(`\n[error] ${event.message}\n`);
      return;
    case "tool_call_start":
      process.stderr.write(`\n[tool] ${event.toolName}\n`);
      return;
    case "tool_call_end":
      process.stderr.write(`[tool_result] ${JSON.stringify(event.result)}\n`);
      return;
    case "state":
      process.stderr.write(`\n[state] ${event.state}\n`);
      return;
  }
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
    console.error("Gmail connect failed:", formatError(err));
  }

  const respond = (() => {
    let parentPort: FakeParentPort;

    const send = (message: WorkerMessage): void => {
      parentPort.dispatch(message);
    };

    const sendRpcResult = async (
      kind: "db" | "gmail",
      requestId: string,
      work: Promise<unknown>,
    ): Promise<void> => {
      try {
        send({ type: `${kind}_response`, requestId, result: await work } as WorkerMessage);
      } catch (err) {
        send({ type: `${kind}_error`, requestId, error: formatError(err) } as WorkerMessage);
      }
    };

    const sendNetFetchResult = async (
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
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const result: NetFetchResult = {
          status: response.status,
          headers,
          body: await response.text(),
        };
        send({ type: "net_fetch_response", requestId, result });
      } catch (err) {
        send({ type: "net_fetch_error", requestId, error: formatError(err) });
      }
    };

    parentPort = createFakeParentPort((message) => {
      switch (message.type) {
        case "db_request":
          void sendRpcResult(
            "db",
            message.requestId,
            invokeMethod(db as Record<string, unknown>, "DB", message.method, message.args),
          );
          return;
        case "gmail_request":
          void sendRpcResult(
            "gmail",
            message.requestId,
            invokeMethod(
              gmailClient as unknown as Record<string, unknown> | null,
              "Gmail",
              message.method,
              message.args,
            ),
          );
          return;
        case "net_fetch_request":
          void sendNetFetchResult(message.requestId, message.url, message.options);
          return;
        case "confirmation_request":
          process.stderr.write(`[auto-approve] ${message.toolName}: ${message.description}\n`);
          send({
            type: "confirm",
            toolCallId: message.toolCallId,
            approved: true,
          });
          return;
        case "providers_list":
        case "provider_loaded":
        case "provider_load_error":
        case "provider_health":
          return;
      }
    });

    return parentPort;
  })();

  (process as HeadlessProcess).parentPort = respond;
  return respond;
}

async function runTask(
  parentPort: FakeParentPort,
  task: string,
  context: AgentContext,
): Promise<{ state: TerminalState; error?: string }> {
  const taskId = randomUUID();

  return await new Promise((resolve) => {
    let finalError: string | undefined;
    const port = createFakeMessagePort((event) => {
      logEvent(event);

      if (event.type === "error") {
        finalError = event.message;
      }

      if (
        event.type === "state" &&
        (event.state === "completed" || event.state === "failed" || event.state === "cancelled")
      ) {
        resolve(finalError ? { state: event.state, error: finalError } : { state: event.state });
      }
    });

    parentPort.dispatch(
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
}

async function main(): Promise<void> {
  const accountId = process.env["EXO_ACCOUNT_ID"] ?? "default";
  installCleanup(ensureHeadlessDataDir(accountId));

  const parentPort = await createCoordinatorBridge();
  await import("./main/agents/agent-worker");
  parentPort.dispatch({ type: "init", config: buildFrameworkConfig() });

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

  console.error(`Running task: ${task}`);
  const result = await runTask(parentPort, task, {
    accountId,
    userEmail: process.env["EXO_USER_EMAIL"] ?? "user@example.com",
    userName: process.env["EXO_USER_NAME"] ?? "User",
  });

  console.log(
    JSON.stringify({
      status: result.state,
      ...(result.error ? { error: result.error } : {}),
    }),
  );

  if (result.state !== "completed") {
    process.exit(result.state === "cancelled" ? 130 : 1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
