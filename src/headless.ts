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
import type {
  OrchestratorDeps,
  AgentFrameworkConfig,
  ScopedAgentEvent,
  ConfirmationDetails,
  NetFetchResult,
} from "./main/agents/types";
import type { GmailClient } from "./main/services/gmail-client";
import type { AgentContext } from "./shared/agent-types";
import {
  ConfigSchema,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_STYLE_PROMPT,
  resolveModelId,
  type Config,
  type DashboardEmail,
  type Email,
  type GeneratedDraftResponse,
  type AnalysisResult,
} from "./shared/types";

type DbModule = typeof import("./main/db");

let dbModulePromise: Promise<DbModule> | null = null;
let styleProfilerPromise: Promise<typeof import("./main/services/style-profiler")> | null = null;
let memoryContextPromise: Promise<typeof import("./main/services/memory-context")> | null = null;
let orchestratorPromise: Promise<typeof import("./main/agents/orchestrator")> | null = null;
let gmailClientPromise: Promise<typeof import("./main/services/gmail-client")> | null = null;

async function getDbModule(): Promise<DbModule> {
  dbModulePromise ??= import("./main/db");
  return dbModulePromise;
}

async function getStyleProfilerModule(): Promise<typeof import("./main/services/style-profiler")> {
  styleProfilerPromise ??= import("./main/services/style-profiler");
  return styleProfilerPromise;
}

async function getMemoryContextModule(): Promise<typeof import("./main/services/memory-context")> {
  memoryContextPromise ??= import("./main/services/memory-context");
  return memoryContextPromise;
}

async function getOrchestratorModule(): Promise<typeof import("./main/agents/orchestrator")> {
  orchestratorPromise ??= import("./main/agents/orchestrator");
  return orchestratorPromise;
}

async function getGmailClientModule(): Promise<typeof import("./main/services/gmail-client")> {
  gmailClientPromise ??= import("./main/services/gmail-client");
  return gmailClientPromise;
}

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

function logHeadlessEvent(event: ScopedAgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stderr.write(`[text] ${event.text}\n`);
      return;
    case "user_message":
      process.stderr.write(`[user] ${event.text}\n`);
      return;
    case "tool_call_start":
      process.stderr.write(
        `[tool:start] ${event.toolName} ${JSON.stringify(event.input)}\n`,
      );
      return;
    case "tool_call_end":
      process.stderr.write(
        `[tool:end] ${event.toolCallId} ${JSON.stringify(event.result)}\n`,
      );
      return;
    case "tool_call_pending":
      process.stderr.write(
        `[tool:pending] ${event.toolName} ${event.pendingState}\n`,
      );
      return;
    case "confirmation_required":
      process.stderr.write(
        `[confirm] ${event.toolName}: ${event.description}\n`,
      );
      return;
    case "state":
      process.stderr.write(`[state] ${event.state}${event.message ? ` ${event.message}` : ""}\n`);
      return;
    case "error":
      process.stderr.write(`[error] ${event.message}\n`);
      return;
    case "done":
      process.stderr.write(`[done] ${event.summary}\n`);
      return;
  }
}

let cachedHeadlessConfig: Config | null = null;

function getHeadlessConfig(): Config {
  if (cachedHeadlessConfig) return cachedHeadlessConfig;

  const configPath = join(process.env["EXO_DATA_DIR"] ?? process.cwd(), "exo-config.json");
  let storedConfig: unknown = {};

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      storedConfig =
        parsed && typeof parsed === "object" && "config" in parsed
          ? (parsed as { config?: unknown }).config ?? {}
          : parsed;
    } catch (err) {
      console.error("Failed to read Exo config:", err instanceof Error ? err.message : err);
    }
  }

  const config = ConfigSchema.parse(storedConfig ?? {});
  if (!config.anthropicApiKey) {
    config.anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? process.env["EXO_API_KEY"];
  }

  cachedHeadlessConfig = config;
  return config;
}

function getHeadlessModelId(feature: keyof typeof DEFAULT_MODEL_CONFIG): string {
  const config = getHeadlessConfig();
  const modelConfig = { ...DEFAULT_MODEL_CONFIG, ...config.modelConfig };
  return resolveModelId(modelConfig[feature]);
}

function extractEmail(field: string): string {
  const match = field.match(/<([^>]+)>/) ?? field.match(/([^\s<]+@[^\s>]+)/);
  return match ? match[1] : field;
}

async function saveDraftAndSyncHeadlessly(
  emailId: string,
  body: string,
  status: string,
  getGmailClient: (accountId: string) => Promise<GmailClient | null>,
  cc?: string[],
  bcc?: string[],
  composeMode?: string,
  to?: string[],
): Promise<void> {
  const db = await getDbModule();
  const email = db.getEmail(emailId);
  if (!email) {
    throw new Error(`Email not found: ${emailId}`);
  }

  const oldGmailDraftId = email.draft?.gmailDraftId;
  db.saveDraft(emailId, body, status, undefined, {
    ...(to !== undefined ? { to } : {}),
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    ...(composeMode !== undefined ? { composeMode } : {}),
  });

  const savedDraft = db.getEmail(emailId)?.draft;
  const syncCc = cc ?? savedDraft?.cc;
  const syncBcc = bcc ?? savedDraft?.bcc;
  const syncComposeMode = composeMode ?? savedDraft?.composeMode;
  const syncTo = to ?? savedDraft?.to;

  const accountId = email.accountId || "default";
  const gmailClient = await getGmailClient(accountId);
  if (!gmailClient) {
    return;
  }

  try {
    if (oldGmailDraftId) {
      try {
        await gmailClient.deleteDraft(oldGmailDraftId);
      } catch {
        // Best-effort replacement; stale remote drafts should not block local state.
      }
    }

    const isForward = syncComposeMode === "forward";
    const replyTo = extractEmail(email.from);
    const subjectBase = email.subject.replace(/^(?:Re|Fwd|Fw):\s*/i, "");
    const parentMessageId = isForward ? undefined : db.getEmailMessageIdHeader(emailId) ?? undefined;

    const result = await gmailClient.createDraft({
      to: isForward ? syncTo?.join(", ") || "" : replyTo,
      subject: isForward ? `Fwd: ${subjectBase}` : email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
      body,
      threadId: email.threadId,
      cc: syncCc,
      bcc: syncBcc,
      inReplyTo: parentMessageId,
      references: parentMessageId,
    });

    db.updateDraftGmailId(emailId, result.id);
  } catch (err) {
    console.error(
      `[headless] Gmail draft sync failed for ${emailId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function readContextOverrides(): Partial<AgentContext> {
  const raw = process.env["EXO_AGENT_CONTEXT_JSON"]?.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Context override must be a JSON object");
    }

    const context = parsed as Partial<AgentContext>;
    return {
      accountId: typeof context.accountId === "string" ? context.accountId : undefined,
      currentEmailId: typeof context.currentEmailId === "string" ? context.currentEmailId : undefined,
      currentThreadId: typeof context.currentThreadId === "string" ? context.currentThreadId : undefined,
      currentDraftId: typeof context.currentDraftId === "string" ? context.currentDraftId : undefined,
      selectedEmailIds: Array.isArray(context.selectedEmailIds)
        ? context.selectedEmailIds.filter((value): value is string => typeof value === "string")
        : undefined,
      userEmail: typeof context.userEmail === "string" ? context.userEmail : undefined,
      userName: typeof context.userName === "string" ? context.userName : undefined,
      emailSubject: typeof context.emailSubject === "string" ? context.emailSubject : undefined,
      emailFrom: typeof context.emailFrom === "string" ? context.emailFrom : undefined,
      emailTo: typeof context.emailTo === "string" ? context.emailTo : undefined,
      emailBody: typeof context.emailBody === "string" ? context.emailBody : undefined,
      conversationHistory:
        typeof context.conversationHistory === "string" ? context.conversationHistory : undefined,
      memoryContext: typeof context.memoryContext === "string" ? context.memoryContext : undefined,
      providerConversationIds:
        context.providerConversationIds &&
        typeof context.providerConversationIds === "object" &&
        !Array.isArray(context.providerConversationIds)
          ? Object.fromEntries(
              Object.entries(context.providerConversationIds).filter(
                (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
              ),
            )
          : undefined,
    };
  } catch (err) {
    throw new Error(
      `Invalid EXO_AGENT_CONTEXT_JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function generateDraftHeadlessly(
  emailId: string,
  requestedAccountId: string,
  getGmailClient: (accountId: string) => Promise<GmailClient | null>,
  instructions?: string,
): Promise<GeneratedDraftResponse> {
  const db = await getDbModule();
  const email = db.getEmail(emailId);
  if (!email) throw new Error(`Email not found: ${emailId}`);

  const config = getHeadlessConfig();
  const emailAccountId = requestedAccountId || email.accountId || "default";
  const recipientEmail = extractEmail(email.from);
  const gmailClient = recipientEmail ? await getGmailClient(emailAccountId) : null;
  const { buildStyleContext } = await getStyleProfilerModule();
  const styleContext = recipientEmail
    ? await buildStyleContext(
        recipientEmail,
        emailAccountId,
        config.stylePrompt ?? DEFAULT_STYLE_PROMPT,
        gmailClient,
      )
    : "";
  const { buildMemoryContext } = await getMemoryContextModule();
  const memoryContext = recipientEmail
    ? buildMemoryContext(recipientEmail.toLowerCase(), emailAccountId)
    : "";

  let prompt = config.draftPrompt;
  if (styleContext) prompt = `${styleContext}\n\n${prompt}`;
  if (memoryContext) prompt = `${memoryContext}\n\n${prompt}`;
  if (instructions) prompt = `${prompt}\n\nADDITIONAL INSTRUCTIONS:\n${instructions}`;

  const emailForDraft: Email = {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    body: email.body ?? "",
    snippet: email.snippet,
  };

  let analysis: AnalysisResult;
  if (email.analysis) {
    analysis = {
      needs_reply: email.analysis.needsReply,
      reason: email.analysis.reason,
      priority: email.analysis.priority,
    };
  } else {
    const { EmailAnalyzer } = await import("./main/services/email-analyzer");
    const accounts = db.getAccounts();
    const userEmail = accounts.find((account) => account.id === emailAccountId)?.email;
    const analyzer = new EmailAnalyzer(
      getHeadlessModelId("analysis"),
      config.analysisPrompt ?? undefined,
    );
    analysis = await analyzer.analyze(emailForDraft, userEmail, emailAccountId);
    db.saveAnalysis(emailId, analysis.needs_reply, analysis.reason, analysis.priority);
  }

  const userEmail = db.getAccounts().find((account) => account.id === emailAccountId)?.email;
  const { DraftGenerator } = await import("./main/services/draft-generator");
  const generator = new DraftGenerator(
    getHeadlessModelId("drafts"),
    prompt,
    getHeadlessModelId("calendaring"),
  );
  const result = await generator.generateDraft(emailForDraft, analysis, config.ea, {
    enableSenderLookup: config.enableSenderLookup ?? true,
    userEmail,
  });

  await saveDraftAndSyncHeadlessly(
    emailId,
    result.body,
    "pending",
    getGmailClient,
    result.cc,
    result.bcc,
  );
  return result;
}

async function generateNewEmailHeadlessly(
  requestedAccountId: string,
  to: string[],
  subject: string,
  instructions: string,
  getGmailClient: (accountId: string) => Promise<GmailClient | null>,
): Promise<GeneratedDraftResponse> {
  const config = getHeadlessConfig();
  const primaryRecipient = to[0] ?? "";
  const primaryEmail = extractEmail(primaryRecipient);
  const gmailClient = primaryEmail ? await getGmailClient(requestedAccountId) : null;
  const { buildStyleContext } = await getStyleProfilerModule();
  const styleContext = primaryEmail
    ? await buildStyleContext(
        primaryEmail,
        requestedAccountId,
        config.stylePrompt ?? DEFAULT_STYLE_PROMPT,
        gmailClient,
      )
    : "";

  let prompt = config.draftPrompt;
  if (styleContext) prompt = `${styleContext}\n\n${prompt}`;

  const { DraftGenerator } = await import("./main/services/draft-generator");
  const generator = new DraftGenerator(
    getHeadlessModelId("drafts"),
    prompt,
    getHeadlessModelId("calendaring"),
  );

  return generator.composeNewEmail(to, subject, instructions, {
    enableSenderLookup: config.enableSenderLookup ?? true,
  });
}

async function generateForwardHeadlessly(
  emailId: string,
  requestedAccountId: string,
  instructions: string,
  to: string[] | undefined,
  cc: string[] | undefined,
  bcc: string[] | undefined,
  getGmailClient: (accountId: string) => Promise<GmailClient | null>,
): Promise<GeneratedDraftResponse> {
  const db = await getDbModule();
  const email = db.getEmail(emailId);
  if (!email) throw new Error(`Email not found: ${emailId}`);

  const config = getHeadlessConfig();
  const primaryRecipient = to?.[0] ?? "";
  const primaryEmail = extractEmail(primaryRecipient);
  const gmailClient = primaryEmail ? await getGmailClient(requestedAccountId) : null;
  const { buildStyleContext } = await getStyleProfilerModule();
  const styleContext = primaryEmail
    ? await buildStyleContext(
        primaryEmail,
        requestedAccountId,
        config.stylePrompt ?? DEFAULT_STYLE_PROMPT,
        gmailClient,
      )
    : "";

  let prompt = config.draftPrompt;
  if (styleContext) prompt = `${styleContext}\n\n${prompt}`;

  const { DraftGenerator } = await import("./main/services/draft-generator");
  const emailForDraft: Email = {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    body: email.body ?? "",
    snippet: email.snippet,
  };

  const generator = new DraftGenerator(
    getHeadlessModelId("drafts"),
    prompt,
    getHeadlessModelId("calendaring"),
  );
  const result = await generator.generateForward(emailForDraft, instructions, {
    enableSenderLookup: config.enableSenderLookup ?? true,
  });

  await saveDraftAndSyncHeadlessly(
    emailId,
    result.body,
    "pending",
    getGmailClient,
    cc,
    bcc,
    "forward",
    to,
  );
  return result;
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

  const db = await getDbModule();
  db.initDatabase();

  // ── Initialize Gmail client ─────────────────────────────────────────

  const gmailClients = new Map<string, GmailClient>();

  const getGmailClient = async (requestedAccountId: string): Promise<GmailClient | null> => {
    const cached = gmailClients.get(requestedAccountId);
    if (cached) {
      return cached;
    }

    initIsolatedDataDir(requestedAccountId);

    try {
      const { GmailClient } = await getGmailClientModule();
      const client = new GmailClient(requestedAccountId);
      await client.connect();
      gmailClients.set(requestedAccountId, client);
      console.error(`Gmail client connected (${requestedAccountId})`);
      return client;
    } catch (err) {
      console.error(
        `Gmail connect failed (${requestedAccountId}):`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };

  await getGmailClient(accountId);

  const headlessDbMethods = {
    ...db,
    saveDraftAndSync: async (
      emailId: string,
      body: string,
      status: string,
      cc?: string[],
      bcc?: string[],
      composeMode?: string,
      to?: string[],
    ) => saveDraftAndSyncHeadlessly(emailId, body, status, getGmailClient, cc, bcc, composeMode, to),
    generateDraft: async (emailId: string, requestedAccountId: string, instructions?: string) =>
      generateDraftHeadlessly(emailId, requestedAccountId, getGmailClient, instructions),
    generateNewEmail: async (
      requestedAccountId: string,
      to: string[],
      subject: string,
      instructions: string,
    ) => generateNewEmailHeadlessly(requestedAccountId, to, subject, instructions, getGmailClient),
    generateForward: async (
      emailId: string,
      requestedAccountId: string,
      instructions: string,
      to?: string[],
      cc?: string[],
      bcc?: string[],
    ) => generateForwardHeadlessly(emailId, requestedAccountId, instructions, to, cc, bcc, getGmailClient),
  } satisfies Record<string, unknown>;

  const dbProxy: OrchestratorDeps["dbProxy"] = async (method: string, ...args: unknown[]) => {
    const proxy = makeProxy(headlessDbMethods, "db");
    return proxy(method, ...args);
  };

  const gmailProxy: OrchestratorDeps["gmailProxy"] = async (
    method: string,
    requestedAccountId: string,
    ...args: unknown[]
  ) => {
    const gmailClient = await getGmailClient(requestedAccountId || accountId);
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
    logHeadlessEvent(event);
  };

  let resolveHeadlessConfirmation:
    | ((toolCallId: string, approved: boolean) => void)
    | null = null;

  const requestConfirmation = (details: ConfirmationDetails): void => {
    process.stderr.write(
      `[auto-approve] ${details.toolName}: ${details.description}\n`,
    );
    resolveHeadlessConfirmation?.(details.toolCallId, true);
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

  const { AgentOrchestrator } = await getOrchestratorModule();
  const orchestrator = new AgentOrchestrator(deps);
  resolveHeadlessConfirmation = (toolCallId: string, approved: boolean) => {
    orchestrator.resolveConfirmation(toolCallId, approved);
  };

  const taskId = randomUUID();
  const contextOverrides = readContextOverrides();
  const context: AgentContext = {
    accountId: contextOverrides.accountId ?? accountId,
    currentEmailId: contextOverrides.currentEmailId,
    currentThreadId: contextOverrides.currentThreadId,
    currentDraftId: contextOverrides.currentDraftId,
    selectedEmailIds: contextOverrides.selectedEmailIds,
    userEmail:
      contextOverrides.userEmail ??
      process.env["EXO_USER_EMAIL"] ??
      "user@example.com",
    userName:
      contextOverrides.userName ??
      process.env["EXO_USER_NAME"] ??
      "User",
    emailSubject: contextOverrides.emailSubject,
    emailFrom: contextOverrides.emailFrom,
    emailTo: contextOverrides.emailTo,
    emailBody: contextOverrides.emailBody,
    providerConversationIds: contextOverrides.providerConversationIds,
    conversationHistory: contextOverrides.conversationHistory,
    memoryContext: contextOverrides.memoryContext,
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
